import Foundation
import ReelCore

/// Uploads a recording's HLS segments (`init.mp4`, `segNNNNN.m4s`) and playlist. During capture
/// it runs live: each segment is queued the moment the writer closes it (Loom's
/// RecordingUploader does the same with its TS parts), so when recording stops only the last
/// few seconds are left to send. The same type resumes an interrupted upload later (crash
/// recovery, retry from the Library) from the progress saved in `segments/upload.json`.
actor SegmentUploader {
    let shareID: String
    private let ownerUID: String
    let directory: URL
    private(set) var location: RemoteLocation
    private var options: StorageRequests.ObjectOptions
    private var progress: SegmentLog          // only the upload fields are used/persisted here
    private var segments: [Int: SegmentEntry] = [:]
    private var hasInit = false
    private var pumping = false
    private var playlistDirty = false
    private(set) var lastError: String?
    private var failures = 0
    private var finishing = false
    /// Uploaded bytes, for progress UI.
    private(set) var bytesSent = 0

    static let progressFile = "upload.json"

    init(shareID: String, ownerUID: String, directory: URL, location: RemoteLocation, expiresAt: Date?, recordingNonce: String?) {
        self.shareID = shareID
        self.ownerUID = ownerUID
        self.directory = directory
        self.location = location
        self.options = .init(expiresAt: expiresAt, recordingNonce: recordingNonce)
        var p = Self.loadProgress(directory: directory) ?? SegmentLog()
        if p.uploadedLocation != location { p.resetUploads(to: location) }
        self.progress = p
    }

    static func loadProgress(directory: URL) -> SegmentLog? {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(progressFile)) else { return nil }
        return try? JSONDecoder().decode(SegmentLog.self, from: data)
    }

    static func loadLog(directory: URL) -> SegmentLog? {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(SegmentLog.fileName)) else { return nil }
        return try? JSONDecoder().decode(SegmentLog.self, from: data)
    }

    /// The writer's log merged with this uploader's progress.
    static func combinedLog(directory: URL) -> SegmentLog? {
        guard var log = loadLog(directory: directory) else { return nil }
        if let p = loadProgress(directory: directory) {
            log.uploadedLocation = p.uploadedLocation
            log.uploadedInit = p.uploadedInit
            log.uploaded = p.uploaded
            log.uploadedFinalPlaylist = p.uploadedFinalPlaylist
        }
        return log
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(progress) {
            try? data.write(to: directory.appendingPathComponent(Self.progressFile), options: .atomic)
        }
    }

    /// Writer callback: a segment (or the init segment, entry == nil) is on disk.
    func segmentWritten(_ entry: SegmentEntry?, log: SegmentLog) {
        hasInit = hasInit || log.hasInit
        for s in log.segments { segments[s.index] = s }
        if let entry { segments[entry.index] = entry }
        playlistDirty = true
        startPump()
    }

    private func startPump() {
        guard !pumping else { return }
        pumping = true
        Task { await self.pump() }
    }

    /// Uploads everything pending, in order (init first), then refreshes the live playlist.
    private func pump() async {
        defer { pumping = false }
        while true {
            do {
                if hasInit && !progress.uploadedInit {
                    try await uploadFile(.initSegment)
                    progress.uploadedInit = true
                    persist()
                    continue
                }
                guard progress.uploadedInit else { return }
                let pending = segments.values.filter { !progress.uploaded.contains($0.index) }.sorted { $0.index < $1.index }
                if let next = pending.first {
                    try await uploadFile(next.file)
                    progress.uploaded.insert(next.index)
                    persist()
                    failures = 0
                    continue
                }
                if playlistDirty {
                    playlistDirty = false
                    try await uploadPlaylist(ended: false)
                }
                return
            } catch {
                lastError = error.localizedDescription
                failures += 1
                Log.cloud.error("Live upload: \(error.localizedDescription, privacy: .public)")
                if finishing || (error as? CloudError)?.isPermanent == true || failures > 20 { return }
                try? await Task.sleep(for: .seconds(min(10, Double(failures))))
            }
        }
    }

    private static func publisherSession(ownerUID: String) async throws -> CloudSession {
        let cloud = try await CloudAuth.shared.validSession()
        guard cloud.userID == ownerUID else {
            throw CloudError.permanent("Your account changed. Sign in with the recording's publisher to continue uploading.")
        }
        return cloud
    }

    private func uploadFile(_ file: RemoteFile) async throws {
        let data = try Data(contentsOf: directory.appendingPathComponent(file.rawValue), options: .mappedIfSafe)
        let cloud = try await Self.publisherSession(ownerUID: ownerUID)
        try await StorageClient(session: cloud).upload(data: data, shareID: shareID, file: file, location: location, options: options)
        bytesSent += data.count
    }

    private func uploadPlaylist(ended: Bool) async throws {
        let ordered = segments.values.filter { progress.uploaded.contains($0.index) }.sorted { $0.index < $1.index }
        // A live playlist may only list a contiguous uploaded prefix.
        var listed: [SegmentEntry] = []
        for (i, s) in ordered.enumerated() where s.index == i + 1 { listed.append(s) }
        let shareID = shareID, location = location
        let text = HLSPlaylist.make(segments: listed, ended: ended) {
            ShareLinks.downloadURL(shareID: shareID, file: $0, location: location).absoluteString
        }
        let cloud = try await Self.publisherSession(ownerUID: ownerUID)
        try await StorageClient(session: cloud).upload(data: Data(text.utf8), shareID: shareID, file: .playlist, location: location, options: options)
    }

    /// After capture: uploads whatever is left from `log` and the final VOD playlist. Throws if
    /// anything can't be uploaded (the caller marks the recording for retry).
    func finish(log: SegmentLog) async throws {
        finishing = true
        hasInit = log.hasInit
        for s in log.segments { segments[s.index] = s }
        while pumping { try await Task.sleep(for: .milliseconds(50)) }
        if !progress.uploadedInit {
            try await uploadFile(.initSegment)
            progress.uploadedInit = true
            persist()
        }
        let pending = log.segments.filter { !progress.uploaded.contains($0.index) }
        let shareID = shareID, ownerUID = ownerUID, location = location, options = options, dir = directory
        // Catch up in parallel when the live upload fell behind (or after a crash).
        try await StorageClient.concurrently(pending, width: 4) { s in
            let data = try Data(contentsOf: dir.appendingPathComponent(s.file.rawValue), options: .mappedIfSafe)
            let cloud = try await Self.publisherSession(ownerUID: ownerUID)
            try await StorageClient(session: cloud).upload(data: data, shareID: shareID, file: s.file, location: location, options: options)
        }
        for s in pending { progress.uploaded.insert(s.index) }
        persist()
        try await uploadPlaylist(ended: true)
        progress.uploadedFinalPlaylist = true
        persist()
    }

    var uploadedCount: Int { progress.uploaded.count }
}
