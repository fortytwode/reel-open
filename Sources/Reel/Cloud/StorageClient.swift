import Foundation
import ReelCore

/// Executes ReelCore.StorageRequests against Firebase Storage: small files and segments in one
/// multipart request (with retries), the MP4 as a chunked resumable upload with progress.
struct StorageClient {
    let requests: StorageRequests
    var session: URLSession = .shared

    init(session cloud: CloudSession, config: CloudConfig = .default) {
        requests = StorageRequests(config: config, auth: .firebase(idToken: cloud.idToken), ownerUID: cloud.userID)
    }

    init(requests: StorageRequests) {
        self.requests = requests
    }

    /// Small object upload. Retries transient failures (Loom retries a part up to 10 times).
    func upload(data: Data, shareID: String, file: RemoteFile, location: RemoteLocation = .open,
                options: StorageRequests.ObjectOptions = .none, attempts: Int = 6) async throws {
        try requirePublisher(shareID: shareID, recordingNonce: options.recordingNonce)
        var attempt = 0
        while true {
            do {
                let req = requests.multipartUpload(shareID: shareID, file: file, location: location, data: data, options: options)
                _ = try await self.data(for: req, what: file.rawValue)
                return
            } catch let e as CloudError where e.isPermanent {
                throw e
            } catch {
                attempt += 1
                if attempt >= attempts || Task.isCancelled { throw error }
                Log.cloud.error("\(file.rawValue, privacy: .public) failed (attempt \(attempt)): \(error.localizedDescription, privacy: .public)")
                try await Task.sleep(for: .seconds(min(8, 0.5 * pow(2, Double(attempt)))))
            }
        }
    }

    func upload(fileURL: URL, shareID: String, file: RemoteFile, location: RemoteLocation = .open,
                options: StorageRequests.ObjectOptions = .none, progress: @escaping @Sendable (Double) -> Void) async throws {
        try requirePublisher(shareID: shareID, recordingNonce: options.recordingNonce)
        let total = (try FileManager.default.attributesOfItem(atPath: fileURL.path)[.size] as? NSNumber)?.int64Value ?? 0
        let (_, startResponse) = try await data(for: requests.resumableStart(shareID: shareID, file: file, location: location, totalBytes: total, options: options),
                                                what: "start \(file.rawValue)")
        guard let sessionString = startResponse.value(forHTTPHeaderField: "X-Goog-Upload-URL"), let sessionURL = URL(string: sessionString) else {
            throw CloudError.message("Upload could not start (no session URL)")
        }
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        let ranges = StorageRequests.chunkRanges(total: total)
        for (i, range) in ranges.enumerated() {
            try handle.seek(toOffset: UInt64(range.lowerBound))
            let chunk = try handle.read(upToCount: Int(range.count)) ?? Data()
            let isFinal = i == ranges.count - 1
            var attempt = 0
            while true {
                do {
                    let req = StorageRequests.resumableChunk(sessionURL: sessionURL, offset: range.lowerBound, chunk: chunk, isFinal: isFinal)
                    let (_, resp) = try await data(for: req, what: "chunk \(i + 1)/\(ranges.count)")
                    let status = resp.value(forHTTPHeaderField: "X-Goog-Upload-Status") ?? ""
                    if isFinal && status != "final" && status != "" { throw CloudError.message("Upload not finalized (\(status))") }
                    break
                } catch {
                    attempt += 1
                    if attempt >= 6 || Task.isCancelled { throw error }
                    Log.cloud.error("Chunk \(i) failed (attempt \(attempt)): \(error.localizedDescription, privacy: .public)")
                    try await Task.sleep(for: .seconds(Double(attempt) * 1.5))
                }
            }
            progress(Double(range.upperBound) / Double(max(total, 1)))
        }
    }

    /// Sets or clears `expiresAt` on an existing object. Missing objects are skipped.
    func setExpiry(_ expiresAt: Date?, shareID: String, file: RemoteFile, location: RemoteLocation, recordingNonce: String?) async throws {
        try requirePublisher(shareID: shareID, recordingNonce: recordingNonce)
        // Like DELETE, a PATCH on a missing object is denied (403) by the rules, not 404.
        guard try await exists(shareID: shareID, file: file, location: location) else { return }
        let (body, resp) = try await session.data(for: requests.updateMetadata(shareID: shareID, file: file, location: location, expiresAt: expiresAt, recordingNonce: recordingNonce))
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 404 { return }
        guard (200..<300).contains(code) else {
            throw CloudError.message("Couldn't update \(file.rawValue) (HTTP \(code)) \(String(data: body.prefix(200), encoding: .utf8) ?? "")")
        }
    }

    private func requirePublisher(shareID: String, recordingNonce: String?) throws {
        guard let recordingNonce else { return }
        guard ShareLinks.ownerBoundShareID(ownerUID: requests.ownerUID, recordingNonce: recordingNonce) == shareID else {
            throw CloudError.permanent("Sign in with the account that owns this recording to upload it.")
        }
    }

    /// Whether an object exists, using the owner's credentials (works for expired objects too).
    /// Note: the rules answer 403 for missing objects on authenticated metadata reads only when
    /// `resource` is needed; a public 404 means missing.
    func exists(shareID: String, file: RemoteFile, location: RemoteLocation) async throws -> Bool {
        let (_, resp) = try await session.data(for: requests.getMetadata(shareID: shareID, file: file, location: location))
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 404 { return false }
        if (200..<300).contains(code) { return true }
        throw CloudError.message("Couldn't check \(file.rawValue) (HTTP \(code))")
    }

    /// Deletes the given objects (missing ones are fine), 8 at a time.
    func delete(shareID: String, files: [RemoteFile], location: RemoteLocation) async throws {
        let client = self
        try await Self.concurrently(files, width: 8) { f in try await client.deleteOne(shareID: shareID, file: f, location: location) }
    }

    private func deleteOne(shareID: String, file: RemoteFile, location: RemoteLocation) async throws {
        // DELETE on a missing object is denied (403) by the rules rather than 404, so check
        // existence first (as the owner, so expired objects are still found).
        guard try await exists(shareID: shareID, file: file, location: location) else { return }
        let (_, resp) = try await session.data(for: requests.delete(shareID: shareID, file: file, location: location))
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) || code == 404 else {
            throw CloudError.message("Couldn't delete \(file.rawValue) (HTTP \(code))")
        }
    }

    /// Runs `body` over `items` with limited concurrency.
    static func concurrently<T: Sendable>(_ items: [T], width: Int = 6, _ body: @escaping @Sendable (T) async throws -> Void) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            var i = 0
            for _ in 0..<min(width, items.count) {
                let item = items[i]; i += 1
                group.addTask { try await body(item) }
            }
            while try await group.next() != nil {
                if i < items.count {
                    let item = items[i]; i += 1
                    group.addTask { try await body(item) }
                }
            }
        }
    }

    private func data(for req: URLRequest, what: String) async throws -> (Data, HTTPURLResponse) {
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw CloudError.message("No response uploading \(what)") }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data.prefix(300), encoding: .utf8) ?? ""
            if http.statusCode == 403 { throw CloudError.permanent("Upload not allowed for this account (403). \(body)") }
            if http.statusCode == 400 { throw CloudError.permanent("Upload of \(what) rejected (400) \(body)") }
            throw CloudError.message("Upload of \(what) failed (HTTP \(http.statusCode)) \(body)")
        }
        return (data, http)
    }
}
