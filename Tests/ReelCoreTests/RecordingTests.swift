import XCTest
@testable import ReelCore

final class RecordingTests: XCTestCase {
    let utc = TimeZone(identifier: "UTC")!
    // 2026-10-21 14:03:22 UTC
    var date: Date { var c = DateComponents(); c.year = 2026; c.month = 10; c.day = 21; c.hour = 14; c.minute = 3; c.second = 22; c.timeZone = utc
        var cal = Calendar(identifier: .gregorian); cal.timeZone = utc; return cal.date(from: c)! }

    func testDefaultTitle() {
        XCTAssertEqual(Recording.defaultTitle(for: date, locale: Locale(identifier: "en_GB"), timeZone: utc), "Recording – 21 Oct 2026, 14:03")
    }

    func testDefaultTitleRespectsTimeZone() {
        let tokyo = TimeZone(identifier: "Asia/Tokyo")!
        XCTAssertEqual(Recording.defaultTitle(for: date, locale: Locale(identifier: "en_GB"), timeZone: tokyo), "Recording – 21 Oct 2026, 23:03")
    }

    func testFolderName() {
        XCTAssertEqual(Recording.folderName(for: date, shareID: "abcdefghij0123456789", timeZone: utc), "2026-10-21 140322 abcdef")
    }

    func testCleanTitle() {
        XCTAssertEqual(Recording.cleanTitle("  Hello  "), "Hello")
        XCTAssertEqual(Recording.cleanTitle("a\nb"), "a b")
        XCTAssertNil(Recording.cleanTitle("   \n  "))
        XCTAssertNil(Recording.cleanTitle(""))
        XCTAssertEqual(Recording.cleanTitle(String(repeating: "x", count: 500))?.count, 200)
    }

    func sample(upload: UploadState = .pending) -> Recording {
        Recording(id: "local-1", shareID: "abcdefghij0123456789", title: "T", createdAt: date, durationSeconds: 12.5, width: 1920, height: 1080, mode: .window, folderName: "f", upload: upload, transcriptStatus: .ready, hasThumbnail: true)
    }

    func testCodableRoundTrip() throws {
        for state in [UploadState.localOnly, .pending, .uploading, .uploaded, .failed("x")] {
            let r = sample(upload: state)
            let data = try ReelJSON.encoder.encode(r)
            XCTAssertEqual(try ReelJSON.decoder.decode(Recording.self, from: data), r)
        }
    }

    func testNewRecordingBindsOnceAndKeepsItsLocalFolder() throws {
        let nonce = "00112233445566778899aabbccddeeff"
        let provisionalID = "0123456789abcdefghij"
        var recording = Recording(shareID: provisionalID, title: "T", createdAt: date, durationSeconds: 1,
                                  width: 640, height: 480, mode: .screen, folderName: "original-folder",
                                  upload: .localOnly, recordingNonce: nonce)
        recording = try ReelJSON.decoder.decode(Recording.self, from: ReelJSON.encoder.encode(recording))
        XCTAssertFalse(recording.hasPublishableShareID)
        XCTAssertFalse(recording.matchesPublisher("firebase-member"))
        XCTAssertEqual(recording.shareID, provisionalID)

        XCTAssertTrue(recording.bindToPublisher("firebase-member"))
        XCTAssertTrue(recording.hasPublishableShareID)
        XCTAssertEqual(recording.shareID, "r2955d6431ee1195cf9fc2be40389c2208d75961")
        XCTAssertEqual(recording.folderName, "original-folder")
        XCTAssertEqual(recording.recordingNonce, nonce)

        recording = try ReelJSON.decoder.decode(Recording.self, from: ReelJSON.encoder.encode(recording))
        XCTAssertTrue(recording.bindToPublisher("firebase-member"))
        XCTAssertFalse(recording.bindToPublisher("other-member"))
        XCTAssertTrue(recording.matchesPublisher("firebase-member"))
        XCTAssertFalse(recording.matchesPublisher("other-member"))
        XCTAssertEqual(recording.shareID, "r2955d6431ee1195cf9fc2be40389c2208d75961")
        XCTAssertEqual(recording.folderName, "original-folder")
    }

    func testLegacyRecordingDecodesWithoutNonceAndRetainsURL() throws {
        var legacy = sample(upload: .uploaded)
        let data = try ReelJSON.encoder.encode(legacy)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(object["recordingNonce"])
        legacy = try ReelJSON.decoder.decode(Recording.self, from: data)
        let link = legacy.shareURL(config: testOrganization)
        XCTAssertTrue(legacy.bindToPublisher("current-account"))
        XCTAssertEqual(legacy.shareURL(config: testOrganization), link)
    }

    func testRecordingNonceRequiresCanonicalHex() throws {
        let nonce = ShareLinks.newRecordingNonce()
        XCTAssertEqual(nonce.utf8.count, 32)
        XCTAssertNotNil(ShareLinks.ownerBoundShareID(ownerUID: "uid", recordingNonce: nonce))
        XCTAssertNil(ShareLinks.ownerBoundShareID(ownerUID: "uid", recordingNonce: "00112233445566778899aabbccddeeff".uppercased()))
        XCTAssertNil(ShareLinks.ownerBoundShareID(ownerUID: "uid", recordingNonce: "bad"))
    }

    func testUploadStateLabels() {
        XCTAssertEqual(UploadState.failed("boom").label, "Upload failed: boom")
        XCTAssertEqual(UploadState.uploaded.label, "Uploaded")
    }

    func testShareURL() {
        XCTAssertEqual(sample().shareURL(config: testOrganization).absoluteString, "https://record.northwind.example/v/abcdefghij0123456789")
    }

    func testRemoteMetaCopiesFields() {
        let r = sample()
        let m = RemoteMeta(recording: r, status: "ready", ownerName: "Sam", app: "Reel")
        XCTAssertEqual(m.id, r.shareID)
        XCTAssertEqual(m.title, "T")
        XCTAssertEqual(m.createdAt, r.createdAt)
        XCTAssertEqual(m.durationSeconds, 12.5)
        XCTAssertEqual(m.width, 1920)
        XCTAssertEqual(m.height, 1080)
        XCTAssertEqual(m.status, "ready")
        XCTAssertEqual(m.transcriptStatus, "ready")
        XCTAssertTrue(m.hasThumbnail)
        XCTAssertEqual(m.ownerName, "Sam")
        XCTAssertEqual(m.schemaVersion, 2)
    }

    func testCaptureModeLabels() {
        XCTAssertEqual(CaptureMode.camera.label, "Camera only")
        XCTAssertEqual(CaptureMode.allCases.count, 4)
        XCTAssertEqual(CaptureMode.area.label, "Area")
    }
}
