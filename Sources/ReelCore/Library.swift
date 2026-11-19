import CryptoKit
import Darwin
import Foundation

/// The recordings library: one folder per recording under the active organization’s `root`,
/// each holding `recording.json`, `video.mp4`, `transcript.json`, `transcript.txt`, `thumb.jpg`.
/// The folder is the source of truth, so the library survives app reinstalls and users can
/// delete folders in Finder.
public final class LibraryStore: @unchecked Sendable {
    public let root: URL
    private let fm = FileManager.default

    public static let manifestName = "recording.json"

    public init(root: URL) {
        self.root = root
    }

    public static var defaultRoot: URL {
        OrganizationState.current.directory(under: FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0])
    }

    public func folder(for recording: Recording) -> URL { root.appendingPathComponent(recording.folderName, isDirectory: true) }
    public func videoURL(for r: Recording) -> URL { folder(for: r).appendingPathComponent("video.mp4") }
    public func transcriptJSONURL(for r: Recording) -> URL { folder(for: r).appendingPathComponent("transcript.json") }
    public func transcriptTextURL(for r: Recording) -> URL { folder(for: r).appendingPathComponent("transcript.txt") }
    public func thumbnailURL(for r: Recording) -> URL { folder(for: r).appendingPathComponent("thumb.jpg") }

    public func ensureFolder(for r: Recording) throws -> URL {
        let url = folder(for: r)
        try fm.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Newest first. Folders without a readable manifest are skipped (never deleted).
    public func load() -> [Recording] {
        recordingDirectories()
            .compactMap { readRecording(in: $0) }
            .sorted { $0.createdAt > $1.createdAt }
    }

    private func recordingDirectories() -> [URL] {
        (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? []
    }

    private func readRecording(in directory: URL) -> Recording? {
        let manifest = directory.appendingPathComponent(Self.manifestName)
        guard let data = try? Data(contentsOf: manifest),
              var result = try? ReelJSON.decoder.decode(Recording.self, from: data) else { return nil }
        result.folderName = directory.lastPathComponent
        return result
    }

    private func locate(_ recording: Recording) -> (directory: URL, recording: Recording)? {
        let preferred = folder(for: recording)
        if let stored = readRecording(in: preferred), stored.id == recording.id {
            return (preferred, stored)
        }
        for directory in recordingDirectories() where directory != preferred {
            if let stored = readRecording(in: directory), stored.id == recording.id {
                return (directory, stored)
            }
        }
        return nil
    }

    public enum IdentityError: LocalizedError {
        case recordingMissing
        case recordingConflict
        case publisherConflict
        case meetingShareConsentRequired

        public var errorDescription: String? {
            switch self {
            case .recordingMissing: "This recording is no longer in the Library."
            case .recordingConflict: "The recording identity changed in another Reel process. Reopen the Library and try again."
            case .publisherConflict: "Sign in with the account that owns this recording."
            case .meetingShareConsentRequired: "Confirm meeting sharing while signed in with the intended account."
            }
        }
    }

    /// First capture is the only operation allowed to create a recording manifest.
    @discardableResult
    public func insert(_ proposed: Recording) throws -> Recording {
        try proposed.validateMeetingPublisher()
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        return try withRecordingLock(proposed.id) {
            guard locate(proposed) == nil else { throw IdentityError.recordingConflict }
            let directory = folder(for: proposed)
            let data = try ReelJSON.encoder.encode(proposed)
            // Exclusive creation also protects a folder-name collision between different IDs.
            guard mkdir(directory.path, 0o777) == 0 else {
                if errno == EEXIST { throw IdentityError.recordingConflict }
                throw lockError()
            }
            do {
                try data.write(to: directory.appendingPathComponent(Self.manifestName), options: .atomic)
            } catch {
                try? fm.removeItem(at: directory)
                throw error
            }
            return proposed
        }
    }

    @discardableResult
    public func save(_ proposed: Recording) throws -> Recording {
        try updateManifest(for: proposed) { stored in
            var result = proposed
            try result.preserveIdentity(from: stored)
            try result.validateMeetingPublisher()
            result.discardRequested = stored.discardRequested
            return result
        }
    }

    /// Finalization and publishing may finish in either order. Change only local media fields.
    @discardableResult
    public func updateCapture(_ recording: Recording, state: CaptureState, duration: Double,
                              hasThumbnail: Bool? = nil) throws -> Recording {
        try updateManifest(for: recording) { stored in
            var proposal = recording
            try proposal.preserveIdentity(from: stored)
            guard stored.discardRequested != true else { throw IdentityError.recordingMissing }
            var result = stored
            result.captureState = state
            result.durationSeconds = duration
            if let hasThumbnail { result.hasThumbnail = hasThumbnail }
            return result
        }
    }

    public func requestDiscard(_ recording: Recording) throws -> Recording {
        try updateManifest(for: recording) { stored in
            var proposal = recording
            try proposal.preserveIdentity(from: stored)
            var result = stored
            result.discardRequested = true
            return result
        }
    }

    /// First binding uses the latest manifest under the same lock as ordinary writes and deletion.
    public func bindForPublication(_ recording: Recording, ownerUID: String, meetingConsentUID: String? = nil) throws -> Recording {
        try updateManifest(for: recording) { stored in
            guard stored.discardRequested != true else { throw IdentityError.recordingMissing }
            var proposal = recording
            try proposal.preserveIdentity(from: stored)
            var result = stored
            if let meeting = result.meeting {
                guard meetingConsentUID == ownerUID else { throw IdentityError.meetingShareConsentRequired }
                guard meeting.ownerUserID == nil || meeting.ownerUserID == ownerUID else { throw IdentityError.publisherConflict }
                result.meeting?.ownerUserID = ownerUID
            }
            guard result.bindToPublisher(ownerUID) else { throw IdentityError.publisherConflict }
            return result
        }
    }

    private func updateManifest(for recording: Recording, _ modify: (Recording) throws -> Recording) throws -> Recording {
        guard fm.fileExists(atPath: root.path) else { throw IdentityError.recordingMissing }
        return try withRecordingLock(recording.id) {
            guard let (directory, stored) = locate(recording) else { throw IdentityError.recordingMissing }
            var result = try modify(stored)
            result.folderName = directory.lastPathComponent
            let manifest = directory.appendingPathComponent(Self.manifestName)
            try ReelJSON.encoder.encode(result).write(to: manifest, options: .atomic)
            return result
        }
    }

    private func withRecordingLock<T>(_ id: String, _ action: () throws -> T) throws -> T {
        // Keep the inode under the library root so Finder renames, manifest replacements,
        // and moving a recording to Trash cannot split cooperating processes across locks.
        let directory = root.appendingPathComponent(".recording-locks", isDirectory: true)
        guard mkdir(directory.path, 0o700) == 0 || errno == EEXIST else { throw lockError() }
        let key = SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined()
        let descriptor = open(directory.appendingPathComponent(key).path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw lockError() }
        defer { close(descriptor) }
        while flock(descriptor, LOCK_EX) != 0 {
            if errno != EINTR { throw lockError() }
        }
        defer { flock(descriptor, LOCK_UN) }
        return try action()
    }

    private func lockError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }

    /// Moves the folder to the Trash when recoverable and possible, else removes it.
    public func delete(_ r: Recording, recoverable: Bool = true) throws {
        guard fm.fileExists(atPath: root.path) else { return }
        try withRecordingLock(r.id) {
            guard let (directory, _) = locate(r) else { return }
            if recoverable {
                do { try fm.trashItem(at: directory, resultingItemURL: nil) }
                catch { try fm.removeItem(at: directory) }
            } else {
                try fm.removeItem(at: directory)
            }
        }
    }
}
