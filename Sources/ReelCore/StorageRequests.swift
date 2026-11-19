import Foundation

/// Builds Firebase Storage REST requests (the same protocol the Firebase JS SDK uses), so the
/// app needs no Firebase SDK. Pure request construction; the app's uploader executes them.
public struct StorageRequests: Sendable {
    public enum Auth: Sendable, Equatable {
        case firebase(idToken: String)        // normal app path: Firebase Auth ID token, rules apply
        case bearer(accessToken: String)      // Google OAuth token (e.g. gcloud) for admin tooling
        var header: String {
            switch self {
            case .firebase(let t): "Firebase \(t)"
            case .bearer(let t): "Bearer \(t)"
            }
        }
    }

    /// Per-object options carried in Storage metadata.
    public struct ObjectOptions: Equatable, Sendable {
        /// Expiring links: the rules deny reads after this instant (custom metadata `expiresAt`, epoch ms).
        public var expiresAt: Date?
        /// e.g. `attachment; filename="Demo.mp4"` so the viewer's Download button saves the file.
        public var contentDisposition: String?
        public var recordingNonce: String?
        public init(expiresAt: Date? = nil, contentDisposition: String? = nil, recordingNonce: String? = nil) {
            self.expiresAt = expiresAt
            self.contentDisposition = contentDisposition
            self.recordingNonce = recordingNonce
        }
        public static let none = ObjectOptions()
    }

    public var config: CloudConfig
    public var auth: Auth
    public var ownerUID: String

    /// Resumable chunks must be multiples of 256 KiB (except the last one).
    public static let chunkQuantum = 256 * 1024
    public static let defaultChunkSize = 32 * chunkQuantum   // 8 MiB

    public init(config: CloudConfig = .default, auth: Auth, ownerUID: String) {
        self.config = config
        self.auth = auth
        self.ownerUID = ownerUID
    }

    var base: String { "https://firebasestorage.googleapis.com/v0/b/\(config.bucket)/o" }

    public static func cacheControl(for file: RemoteFile) -> String {
        switch file {
        case .meta, .transcriptJSON, .transcriptText, .playlist: "no-cache"
        default: "public, max-age=3600"
        }
    }

    /// Epoch milliseconds as the decimal string the rules parse with `int()`.
    public static func expiryString(_ date: Date) -> String { String(Int64((date.timeIntervalSince1970 * 1000).rounded())) }

    func customMetadata(_ options: ObjectOptions) -> [String: String] {
        var m = ["ownerUid": ownerUID]
        m["recordingNonce"] = options.recordingNonce
        if let e = options.expiresAt { m["expiresAt"] = Self.expiryString(e) }
        return m
    }

    func metadataJSON(path: String, file: RemoteFile, options: ObjectOptions) -> Data {
        var object: [String: Any] = [
            "name": path,
            "contentType": file.contentType,
            "cacheControl": Self.cacheControl(for: file),
            "metadata": customMetadata(options),
        ]
        if let cd = options.contentDisposition { object["contentDisposition"] = cd }
        return try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    /// One-shot multipart upload (metadata + bytes), used for small files and segments.
    public func multipartUpload(shareID: String, file: RemoteFile, location: RemoteLocation = .open, data: Data,
                                options: ObjectOptions = .none, boundary: String = UUID().uuidString) -> URLRequest {
        let path = ShareLinks.objectPath(shareID: shareID, file: file, location: location)
        var request = URLRequest(url: URL(string: "\(base)?name=\(ShareLinks.encodedObjectName(path))")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue(auth.header, forHTTPHeaderField: "Authorization")
        request.setValue("multipart", forHTTPHeaderField: "X-Goog-Upload-Protocol")
        request.setValue("multipart/related; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        body.append(Data("--\(boundary)\r\nContent-Type: application/json; charset=utf-8\r\n\r\n".utf8))
        body.append(metadataJSON(path: path, file: file, options: options))
        body.append(Data("\r\n--\(boundary)\r\nContent-Type: \(file.contentType)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n--\(boundary)--".utf8))
        request.httpBody = body
        return request
    }

    /// Starts a resumable upload; the response's `X-Goog-Upload-URL` header is the session URL.
    public func resumableStart(shareID: String, file: RemoteFile, location: RemoteLocation = .open, totalBytes: Int64,
                               options: ObjectOptions = .none) -> URLRequest {
        let path = ShareLinks.objectPath(shareID: shareID, file: file, location: location)
        var request = URLRequest(url: URL(string: "\(base)?name=\(ShareLinks.encodedObjectName(path))")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue(auth.header, forHTTPHeaderField: "Authorization")
        request.setValue("resumable", forHTTPHeaderField: "X-Goog-Upload-Protocol")
        request.setValue("start", forHTTPHeaderField: "X-Goog-Upload-Command")
        request.setValue(String(totalBytes), forHTTPHeaderField: "X-Goog-Upload-Header-Content-Length")
        request.setValue(file.contentType, forHTTPHeaderField: "X-Goog-Upload-Header-Content-Type")
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.httpBody = metadataJSON(path: path, file: file, options: options)
        return request
    }

    public static func resumableChunk(sessionURL: URL, offset: Int64, chunk: Data, isFinal: Bool) -> URLRequest {
        var request = URLRequest(url: sessionURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 300
        request.setValue(isFinal ? "upload, finalize" : "upload", forHTTPHeaderField: "X-Goog-Upload-Command")
        request.setValue(String(offset), forHTTPHeaderField: "X-Goog-Upload-Offset")
        request.httpBody = chunk
        return request
    }

    public static func resumableQuery(sessionURL: URL) -> URLRequest {
        var request = URLRequest(url: sessionURL)
        request.httpMethod = "POST"
        request.setValue("query", forHTTPHeaderField: "X-Goog-Upload-Command")
        return request
    }

    /// Changes an existing object's custom metadata (expiry) without re-uploading it. The
    /// owner UID is always sent so the rules' `ownerUid` checks keep passing; `expiresAt: nil`
    /// removes the expiry.
    public func updateMetadata(shareID: String, file: RemoteFile, location: RemoteLocation = .open, expiresAt: Date?, recordingNonce: String? = nil) -> URLRequest {
        let path = ShareLinks.objectPath(shareID: shareID, file: file, location: location)
        var request = URLRequest(url: URL(string: "\(base)/\(ShareLinks.encodedObjectName(path))")!)
        request.httpMethod = "PATCH"
        request.timeoutInterval = 30
        request.setValue(auth.header, forHTTPHeaderField: "Authorization")
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        // JSON null deletes a custom metadata key.
        let expires: Any = expiresAt.map { Self.expiryString($0) as Any } ?? NSNull()
        var metadata: [String: Any] = ["ownerUid": ownerUID, "expiresAt": expires]
        metadata["recordingNonce"] = recordingNonce
        let body = ["metadata": metadata]
        request.httpBody = try! JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return request
    }

    /// Authenticated metadata GET (the owner can read expired objects).
    public func getMetadata(shareID: String, file: RemoteFile, location: RemoteLocation = .open) -> URLRequest {
        let path = ShareLinks.objectPath(shareID: shareID, file: file, location: location)
        var request = URLRequest(url: URL(string: "\(base)/\(ShareLinks.encodedObjectName(path))")!)
        request.httpMethod = "GET"
        request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue(auth.header, forHTTPHeaderField: "Authorization")
        return request
    }

    public func delete(shareID: String, file: RemoteFile, location: RemoteLocation = .open) -> URLRequest {
        let path = ShareLinks.objectPath(shareID: shareID, file: file, location: location)
        var request = URLRequest(url: URL(string: "\(base)/\(ShareLinks.encodedObjectName(path))")!)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 30
        request.setValue(auth.header, forHTTPHeaderField: "Authorization")
        return request
    }

    /// Chunk boundaries for a resumable upload of `total` bytes.
    public static func chunkRanges(total: Int64, chunkSize: Int = defaultChunkSize) -> [Range<Int64>] {
        precondition(chunkSize > 0 && chunkSize % chunkQuantum == 0)
        guard total > 0 else { return [0..<0] }
        var ranges: [Range<Int64>] = []
        var offset: Int64 = 0
        while offset < total {
            let end = min(total, offset + Int64(chunkSize))
            ranges.append(offset..<end)
            offset = end
        }
        return ranges
    }

    /// `attachment; filename="…"` with a filesystem- and header-safe ASCII name.
    public static func attachmentDisposition(title: String, ext: String = "mp4") -> String {
        let safe = title.unicodeScalars.map { s -> Character in
            let c = Character(s)
            if s.isASCII, c.isLetter || c.isNumber || " -_.,()".contains(c) { return c }
            return "-"
        }
        var name = String(safe).trimmingCharacters(in: .whitespaces)
        while name.contains("--") { name = name.replacingOccurrences(of: "--", with: "-") }
        if name.isEmpty || name == "-" { name = "Reel recording" }
        return "attachment; filename=\"\(String(name.prefix(100))).\(ext)\""
    }
}
