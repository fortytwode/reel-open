import Foundation

/// The recordings library: one folder per recording under the active organization’s `root`,
/// each holding `recording.json`, `video.mp4`, `transcript.json`, `transcript.txt`, `thumb.jpg`.
/// The folder is the source of truth, so the library survives app reinstalls and users can
/// delete folders in Finder.
public final class LibraryStore: @unchecked Sendable {
    public let root: URL
    private let fm = FileManager.default
    private let lock = NSLock()

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
        lock.lock(); defer { lock.unlock() }
        guard let items = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { return [] }
        var result: [Recording] = []
        for dir in items {
            let manifest = dir.appendingPathComponent(Self.manifestName)
            guard let data = try? Data(contentsOf: manifest),
                  var r = try? ReelJSON.decoder.decode(Recording.self, from: data) else { continue }
            r.folderName = dir.lastPathComponent   // tolerate folders renamed in Finder
            result.append(r)
        }
        return result.sorted { $0.createdAt > $1.createdAt }
    }

    public func save(_ r: Recording) throws {
        lock.lock(); defer { lock.unlock() }
        let dir = root.appendingPathComponent(r.folderName, isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let data = try ReelJSON.encoder.encode(r)
        try data.write(to: dir.appendingPathComponent(Self.manifestName), options: .atomic)
    }

    /// Moves the folder to the Trash (recoverable) when possible, else removes it.
    public func delete(_ r: Recording) throws {
        lock.lock(); defer { lock.unlock() }
        let dir = root.appendingPathComponent(r.folderName, isDirectory: true)
        guard fm.fileExists(atPath: dir.path) else { return }
        do { try fm.trashItem(at: dir, resultingItemURL: nil) }
        catch { try fm.removeItem(at: dir) }
    }
}
