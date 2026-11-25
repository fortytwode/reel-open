import XCTest
@testable import ReelCore

final class ReelProductTests: XCTestCase {
    func testInfoPlistValueSelectsTheProductAndDefaultsToRecorder() {
        XCTAssertEqual(ReelProduct(infoValue: "notetaker"), .notetaker)
        XCTAssertEqual(ReelProduct(infoValue: "recorder"), .recorder)
        XCTAssertEqual(ReelProduct(infoValue: nil), .recorder)
        XCTAssertEqual(ReelProduct(infoValue: "Notetaker "), .recorder)
        XCTAssertEqual(ReelProduct(infoValue: 1), .recorder)
    }

    func testEachProductHasItsOwnNameAndLinkScheme() {
        XCTAssertEqual(ReelProduct.recorder.displayName, "Reel Recorder")
        XCTAssertEqual(ReelProduct.notetaker.displayName, "Reel Notetaker")
        XCTAssertEqual(ReelProduct.recorder.urlScheme, "reel")
        XCTAssertEqual(ReelProduct.notetaker.urlScheme, "reel-notetaker")
    }

    func testNotetakerOwnsMeetingsAndRecorderOwnsScreenRecordings() {
        XCTAssertTrue(ReelProduct.notetaker.owns(meeting: true, notetakerInstalled: true))
        XCTAssertFalse(ReelProduct.notetaker.owns(meeting: false, notetakerInstalled: true))
        XCTAssertTrue(ReelProduct.recorder.owns(meeting: false, notetakerInstalled: true))
        XCTAssertFalse(ReelProduct.recorder.owns(meeting: true, notetakerInstalled: true))
    }

    func testRecorderAloneKeepsHandlingMeetings() {
        XCTAssertTrue(ReelProduct.recorder.owns(meeting: true, notetakerInstalled: false))
        XCTAssertTrue(ReelProduct.recorder.owns(meeting: false, notetakerInstalled: false))
    }

    func testBothAppsShareTheRecordersLocalState() {
        XCTAssertEqual(ReelProduct.stateBundleID(shared: "com.example.reel", own: "com.example.reel.notetaker"), "com.example.reel")
        XCTAssertEqual(ReelProduct.stateBundleID(shared: nil, own: "com.example.reel"), "com.example.reel")
        XCTAssertEqual(ReelProduct.stateBundleID(shared: "", own: nil), "org.reel.app")
        XCTAssertEqual(ReelProduct.notetakerBundleID(stateBundleID: "com.example.reel"), "com.example.reel.notetaker")
    }

    func testCaptureLeaseMarksARecordingLiveUntilReleased() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("reel-lease-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let recorder = LibraryStore(root: root), notetaker = LibraryStore(root: root)
        XCTAssertFalse(notetaker.isCaptureLive("clip"))
        var lease = recorder.beginCapture("clip")
        XCTAssertNotNil(lease)
        XCTAssertTrue(notetaker.isCaptureLive("clip"))
        XCTAssertNil(notetaker.beginCapture("clip"))
        XCTAssertFalse(notetaker.isCaptureLive("another"))
        lease = nil
        XCTAssertFalse(notetaker.isCaptureLive("clip"))
        XCTAssertNotNil(notetaker.beginCapture("clip"))
    }
}
