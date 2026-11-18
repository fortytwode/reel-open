import XCTest
@testable import ReelCore

final class LibraryStoreTests: XCTestCase {
    var root: URL!
    var store: LibraryStore!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("ReelLib-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = LibraryStore(root: root)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func rec(_ folder: String, _ t: TimeInterval) -> Recording {
        Recording(title: folder, createdAt: Date(timeIntervalSince1970: t), durationSeconds: 1, width: 2, height: 2, mode: .screen, folderName: folder)
    }

    func testLoadEmptyAndMissingRoot() {
        XCTAssertEqual(store.load(), [])
        XCTAssertEqual(LibraryStore(root: root.appendingPathComponent("nope")).load(), [])
    }

    func testSaveLoadRoundTrip() throws {
        let r = rec("a", 1_700_000_000)
        try store.save(r)
        XCTAssertEqual(store.load(), [r])
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.folder(for: r).appendingPathComponent("recording.json").path))
    }

    func testNewestFirst() throws {
        try store.save(rec("old", 1000))
        try store.save(rec("new", 3000))
        try store.save(rec("mid", 2000))
        XCTAssertEqual(store.load().map(\.folderName), ["new", "mid", "old"])
    }

    func testFoldersWithoutManifestSkipped() throws {
        try store.save(rec("good", 1000))
        try FileManager.default.createDirectory(at: root.appendingPathComponent("junk"), withIntermediateDirectories: true)
        let bad = root.appendingPathComponent("bad", isDirectory: true)
        try FileManager.default.createDirectory(at: bad, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: bad.appendingPathComponent("recording.json"))
        XCTAssertEqual(store.load().map(\.folderName), ["good"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: bad.path), "unreadable folders must not be deleted")
    }

    func testRenamedFolderReflected() throws {
        let r = rec("before", 1000)
        try store.save(r)
        try FileManager.default.moveItem(at: root.appendingPathComponent("before"), to: root.appendingPathComponent("after"))
        let loaded = store.load()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded[0].folderName, "after")
        XCTAssertEqual(loaded[0].id, r.id)
    }

    func testDeleteRemovesFolder() throws {
        let r = rec("gone", 1000)
        try store.save(r)
        try store.delete(r)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("gone").path))
        XCTAssertEqual(store.load(), [])
    }

    func testDeleteMissingFolderDoesNotThrow() {
        XCTAssertNoThrow(try store.delete(rec("never", 1)))
    }

    func testURLsAndEnsureFolder() throws {
        let r = rec("x", 1)
        XCTAssertEqual(store.videoURL(for: r).lastPathComponent, "video.mp4")
        XCTAssertEqual(store.thumbnailURL(for: r).lastPathComponent, "thumb.jpg")
        XCTAssertEqual(store.transcriptJSONURL(for: r).lastPathComponent, "transcript.json")
        XCTAssertEqual(store.transcriptTextURL(for: r).lastPathComponent, "transcript.txt")
        let dir = try store.ensureFolder(for: r)
        var isDir: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir))
        XCTAssertTrue(isDir.boolValue)
    }
}
