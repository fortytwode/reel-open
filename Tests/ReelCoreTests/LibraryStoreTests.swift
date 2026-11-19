import Darwin
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

    func testStaleFinalizeCannotUndoBindingInAnotherLibraryInstance() throws {
        let cli = LibraryStore(root: root)
        let draft = Recording(title: "Draft", createdAt: Date(timeIntervalSince1970: 1_700_000_000), durationSeconds: 0, width: 2, height: 2,
                              mode: .screen, folderName: "same-folder", recordingNonce: ShareLinks.newRecordingNonce())
        try store.insert(draft)
        let binding = try cli.bindForPublication(draft, ownerUID: "account-a")
        var published = binding
        published.upload = .uploaded
        published.playback.mp4 = true
        try cli.save(published)

        var staleFinalize = draft
        staleFinalize.durationSeconds = 42
        let saved = try store.save(staleFinalize)
        XCTAssertEqual(saved.shareID, binding.shareID)
        XCTAssertEqual(saved.recordingNonce, draft.recordingNonce)
        XCTAssertEqual(saved.folderName, draft.folderName)
        XCTAssertEqual(saved.durationSeconds, 42)
        XCTAssertEqual(saved.upload, .uploaded)
        XCTAssertTrue(saved.playback.mp4)
        XCTAssertThrowsError(try cli.bindForPublication(draft, ownerUID: "account-b")) {
            guard case LibraryStore.IdentityError.publisherConflict = $0 else { return XCTFail("\($0)") }
        }

        var competingBinding = draft
        XCTAssertTrue(competingBinding.bindToPublisher("account-b"))
        XCTAssertThrowsError(try cli.save(competingBinding)) {
            guard case LibraryStore.IdentityError.recordingConflict = $0 else { return XCTFail("\($0)") }
        }
        XCTAssertEqual(cli.load(), [saved])
    }

    func testMeetingConsentMatchesSessionAndPersistedProcessingOwner() throws {
        let cli = LibraryStore(root: root)
        var draft = Recording(title: "Private", createdAt: Date(timeIntervalSince1970: 1_700_000_000), durationSeconds: 0, width: 2, height: 2,
                              mode: .screen, folderName: "private", meeting: MeetingDetails(),
                              recordingNonce: ShareLinks.newRecordingNonce())
        let stale = draft
        try store.insert(draft)
        draft.meeting?.ownerUserID = "account-a"
        try store.save(draft)
        XCTAssertFalse(try XCTUnwrap(cli.load().first).hasPublishableShareID)

        XCTAssertThrowsError(try cli.bindForPublication(stale, ownerUID: "account-b", meetingConsentUID: "account-a")) {
            guard case LibraryStore.IdentityError.meetingShareConsentRequired = $0 else { return XCTFail("\($0)") }
        }
        XCTAssertThrowsError(try cli.bindForPublication(stale, ownerUID: "account-b", meetingConsentUID: "account-b")) {
            guard case LibraryStore.IdentityError.publisherConflict = $0 else { return XCTFail("\($0)") }
        }
        XCTAssertThrowsError(try cli.bindForPublication(stale, ownerUID: "account-a")) {
            guard case LibraryStore.IdentityError.meetingShareConsentRequired = $0 else { return XCTFail("\($0)") }
        }
        let bound = try cli.bindForPublication(stale, ownerUID: "account-a", meetingConsentUID: "account-a")
        XCTAssertTrue(bound.matchesPublisher("account-a"))
        XCTAssertEqual(try store.save(stale).meeting?.ownerUserID, "account-a")

        var competingOwner = stale
        competingOwner.meeting?.ownerUserID = "account-b"
        XCTAssertThrowsError(try store.save(competingOwner)) {
            guard case LibraryStore.IdentityError.publisherConflict = $0 else { return XCTFail("\($0)") }
        }
        XCTAssertEqual(cli.load(), [bound])
    }

    func testExplicitMeetingShareBindsOwnerlessRecordingToConsentingAccount() throws {
        let draft = Recording(title: "Private", createdAt: Date(timeIntervalSince1970: 1_700_000_000), durationSeconds: 0, width: 2, height: 2,
                              mode: .screen, folderName: "private", meeting: MeetingDetails(),
                              recordingNonce: ShareLinks.newRecordingNonce())
        try store.insert(draft)
        let bound = try store.bindForPublication(draft, ownerUID: "account-a", meetingConsentUID: "account-a")
        XCTAssertTrue(bound.matchesPublisher("account-a"))
        XCTAssertEqual(bound.meeting?.ownerUserID, "account-a")
        XCTAssertFalse(bound.permitsPublishing())
    }

    func testLoadEmptyAndMissingRoot() {
        XCTAssertEqual(store.load(), [])
        XCTAssertEqual(LibraryStore(root: root.appendingPathComponent("nope")).load(), [])
    }

    func testSaveLoadRoundTrip() throws {
        let r = rec("a", 1_700_000_000)
        try store.insert(r)
        XCTAssertEqual(store.load(), [r])
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.folder(for: r).appendingPathComponent("recording.json").path))
    }

    func testNewestFirst() throws {
        try store.insert(rec("old", 1000))
        try store.insert(rec("new", 3000))
        try store.insert(rec("mid", 2000))
        XCTAssertEqual(store.load().map(\.folderName), ["new", "mid", "old"])
    }

    func testFoldersWithoutManifestSkipped() throws {
        try store.insert(rec("good", 1000))
        try FileManager.default.createDirectory(at: root.appendingPathComponent("junk"), withIntermediateDirectories: true)
        let bad = root.appendingPathComponent("bad", isDirectory: true)
        try FileManager.default.createDirectory(at: bad, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: bad.appendingPathComponent("recording.json"))
        XCTAssertEqual(store.load().map(\.folderName), ["good"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: bad.path), "unreadable folders must not be deleted")
    }

    func testRenamedFolderReflected() throws {
        let r = rec("before", 1000)
        try store.insert(r)
        try FileManager.default.moveItem(at: root.appendingPathComponent("before"), to: root.appendingPathComponent("after"))
        let loaded = store.load()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded[0].folderName, "after")
        XCTAssertEqual(loaded[0].id, r.id)
    }

    func testRenameThenBindReturnsActualDirectoryAndKeepsMediaThere() throws {
        let otherProcess = LibraryStore(root: root)
        let draft = Recording(title: "Draft", createdAt: Date(timeIntervalSince1970: 1_700_000_000), durationSeconds: 0,
                              width: 2, height: 2, mode: .screen, folderName: "before",
                              recordingNonce: ShareLinks.newRecordingNonce())
        try store.insert(draft)
        let media = Data("temporary clip".utf8)
        try media.write(to: store.videoURL(for: draft))
        let renamed = root.appendingPathComponent("after", isDirectory: true)
        try FileManager.default.moveItem(at: store.folder(for: draft), to: renamed)

        let bound = try otherProcess.bindForPublication(draft, ownerUID: "account-a")
        XCTAssertEqual(bound.folderName, "after")
        XCTAssertTrue(bound.matchesPublisher("account-a"))
        XCTAssertEqual(try Data(contentsOf: otherProcess.videoURL(for: bound)), media)
        XCTAssertEqual(try store.save(draft).folderName, "after")
        XCTAssertEqual(store.load(), [bound])
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.folder(for: draft).path))
    }

    func testDeletedManifestDoesNotReappearFromAStaleSaveOrBind() throws {
        let otherProcess = LibraryStore(root: root)
        let draft = Recording(title: "Draft", createdAt: Date(timeIntervalSince1970: 1_700_000_000), durationSeconds: 0,
                              width: 2, height: 2, mode: .screen, folderName: "deleted",
                              recordingNonce: ShareLinks.newRecordingNonce())
        try store.insert(draft)
        let bound = try otherProcess.bindForPublication(draft, ownerUID: "account-a")
        let manifest = store.folder(for: bound).appendingPathComponent(LibraryStore.manifestName)
        let handle = try FileHandle(forReadingFrom: manifest)
        defer { try? handle.close() }
        try store.delete(bound, recoverable: false)
        var manifestStat = stat()
        XCTAssertEqual(fstat(handle.fileDescriptor, &manifestStat), 0)
        XCTAssertEqual(manifestStat.st_nlink, 0, "nonrecoverable cleanup unlinks the manifest instead of moving it to Trash")
        XCTAssertThrowsError(try otherProcess.save(bound)) {
            guard case LibraryStore.IdentityError.recordingMissing = $0 else { return XCTFail("\($0)") }
        }
        XCTAssertThrowsError(try otherProcess.updateCapture(bound, state: .complete, duration: 12)) {
            guard case LibraryStore.IdentityError.recordingMissing = $0 else { return XCTFail("\($0)") }
        }
        XCTAssertThrowsError(try otherProcess.bindForPublication(draft, ownerUID: "account-a")) {
            guard case LibraryStore.IdentityError.recordingMissing = $0 else { return XCTFail("\($0)") }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.folder(for: draft).path))

        let replacement = rec("deleted", 2000)
        try store.insert(replacement)
        XCTAssertThrowsError(try otherProcess.save(bound))
        XCTAssertThrowsError(try otherProcess.bindForPublication(draft, ownerUID: "account-a"))
        try otherProcess.delete(bound)
        XCTAssertEqual(store.load(), [replacement])
    }

    func testFinalizingAnOldSnapshotPreservesLatestShareAndPublisher() throws {
        var draft = Recording(title: "Finishing", createdAt: Date(timeIntervalSince1970: 1000),
                              durationSeconds: 0, width: 2, height: 2, mode: .screen,
                              folderName: "finishing", recordingNonce: ShareLinks.newRecordingNonce())
        draft.captureState = .finalizing
        try store.insert(draft)
        let publisher = LibraryStore(root: root)
        var sent = try publisher.bindForPublication(draft, ownerUID: "account-a")
        sent.title = "New title"
        sent.upload = .uploaded
        sent.playback.hls = true
        try publisher.save(sent)

        let completed = try store.updateCapture(draft, state: .complete, duration: 42, hasThumbnail: true)
        XCTAssertEqual(completed.captureState, .complete)
        XCTAssertEqual(completed.durationSeconds, 42)
        XCTAssertTrue(completed.hasThumbnail)
        XCTAssertTrue(completed.matchesPublisher("account-a"))
        XCTAssertEqual(completed.title, sent.title)
        XCTAssertEqual(completed.upload, sent.upload)
        XCTAssertTrue(completed.playback.hls)
        XCTAssertEqual(store.load(), [completed])
    }

    func testDiscardIntentSurvivesAStaleSaveAndBlocksFinalization() throws {
        var recording = rec("discard", 1000)
        recording.captureState = .recording
        try store.insert(recording)
        _ = try store.requestDiscard(recording)
        let staleSave = try store.save(recording)
        XCTAssertEqual(staleSave.discardRequested, true)
        XCTAssertFalse(staleSave.permitsPublishing(allowMeetingShare: true))
        XCTAssertThrowsError(try store.updateCapture(recording, state: .complete, duration: 12))
        XCTAssertEqual(LibraryStore(root: root).load().first?.discardRequested, true)
    }

    func testSaveRequiresAReadableManifestEvenWhenTheFolderRemains() throws {
        let draft = rec("empty", 1000)
        let directory = try store.ensureFolder(for: draft)
        XCTAssertThrowsError(try store.save(draft)) {
            guard case LibraryStore.IdentityError.recordingMissing = $0 else { return XCTFail("\($0)") }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent(LibraryStore.manifestName).path))
    }

    func testDeleteRemovesFolder() throws {
        let r = rec("gone", 1000)
        try store.insert(r)
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
