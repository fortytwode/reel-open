import XCTest
@testable import ReelCore

final class ShareLinksTests: XCTestCase {
    let id = "abcdefghij0123456789"

    func testNewShareIDShapeAndValidity() {
        for _ in 0..<50 {
            let s = ShareLinks.newShareID()
            XCTAssertEqual(s.count, 20)
            XCTAssertTrue(s.allSatisfy { ($0 >= "a" && $0 <= "z") || ($0 >= "0" && $0 <= "9") })
            XCTAssertTrue(ShareLinks.isValidShareID(s))
        }
    }

    func testNewShareIDIsDeterministicWithSeededGenerator() {
        struct Counter: RandomNumberGenerator { var n: UInt64 = 0; mutating func next() -> UInt64 { n &+= 0x9E3779B97F4A7C15; return n } }
        var a = Counter(), b = Counter()
        XCTAssertEqual(ShareLinks.newShareID(using: &a), ShareLinks.newShareID(using: &b))
    }

    func testIDsAreUnique() {
        XCTAssertEqual(Set((0..<100).map { _ in ShareLinks.newShareID() }).count, 100)
    }

    func testIsValidShareID() {
        XCTAssertTrue(ShareLinks.isValidShareID(id))
        XCTAssertTrue(ShareLinks.isValidShareID(String(repeating: "a", count: 16)))
        XCTAssertTrue(ShareLinks.isValidShareID(String(repeating: "a", count: 40)))
        XCTAssertFalse(ShareLinks.isValidShareID(String(repeating: "a", count: 15)))
        XCTAssertFalse(ShareLinks.isValidShareID(String(repeating: "a", count: 41)))
        XCTAssertFalse(ShareLinks.isValidShareID("ABCDEFGHIJ0123456789"))
        XCTAssertFalse(ShareLinks.isValidShareID("abcdefghij012345678-"))
    }

    func testShareIDFromViewerURLs() {
        let base = "https://record.northwind.example/v/\(id)"
        XCTAssertEqual(ShareLinks.shareID(from: base), id)
        XCTAssertEqual(ShareLinks.shareID(from: base + "/"), id)
        XCTAssertEqual(ShareLinks.shareID(from: base + "#t=12"), id)
        XCTAssertEqual(ShareLinks.shareID(from: base + "?utm=x"), id)
        XCTAssertEqual(ShareLinks.shareID(from: "  " + base + "\n"), id)
    }

    func testShareIDFromCustomLibraryURL() {
        XCTAssertEqual(ShareLinks.shareID(from: "https://library.northwind.example/reel/\(id)?x=1#t=12"), id)
    }

    func testShareIDFromStorageDownloadURL() {
        let url = "https://firebasestorage.googleapis.com/v0/b/demo-reel.firebasestorage.app/o/reel%2Fv%2F\(id)%2Fmeta.json?alt=media"
        XCTAssertEqual(ShareLinks.shareID(from: url), id)
    }

    func testShareIDFromBareID() {
        XCTAssertEqual(ShareLinks.shareID(from: id), id)
        XCTAssertEqual(ShareLinks.shareID(from: " \(id) "), id)
    }

    func testShareIDRejectsJunk() {
        XCTAssertNil(ShareLinks.shareID(from: ""))
        XCTAssertNil(ShareLinks.shareID(from: "hello world"))
        XCTAssertNil(ShareLinks.shareID(from: "https://record.northwind.example/v/short"))
        XCTAssertNil(ShareLinks.shareID(from: "https://record.northwind.example/v/ABCDEFGHIJ0123456789"))
        XCTAssertNil(ShareLinks.shareID(from: "https://record.northwind.example/"))
        XCTAssertNil(ShareLinks.shareID(from: "https://example.com/x/\(id)"))
    }

    func testDownloadURLEncodesSlashes() {
        let url = ShareLinks.downloadURL(shareID: id, file: .meta, config: testOrganization).absoluteString
        XCTAssertEqual(url, "https://firebasestorage.googleapis.com/v0/b/demo-reel.firebasestorage.app/o/reel%2Fv%2F\(id)%2Fmeta.json?alt=media")
        XCTAssertTrue(url.hasSuffix("?alt=media"))
    }

    func testViewerURL() {
        XCTAssertEqual(ShareLinks.viewerURL(shareID: id, config: testOrganization).absoluteString, "https://record.northwind.example/v/\(id)")
    }

    func testNotetakerUsesOrganizationHostingAndSupportsOlderConfigurations() {
        var config = testOrganization
        XCTAssertEqual(config.notetakerURL?.absoluteString, "https://record.northwind.example/notetaker")
        config.webBase = URL(string: "https://tools.northwind.example")
        XCTAssertEqual(config.notetakerURL?.absoluteString, "https://tools.northwind.example/notetaker")
        config.webBase = URL(string: "http://localhost:5000")
        XCTAssertEqual(config.notetakerURL?.absoluteString, "http://localhost:5000/notetaker")
        config.webBase = URL(string: "https://someone@tools.northwind.example")
        XCTAssertNil(config.notetakerURL)
    }

    func testObjectPathAndContentTypes() {
        XCTAssertEqual(ShareLinks.objectPath(shareID: id, file: .video), "reel/v/\(id)/video.mp4")
        XCTAssertEqual(RemoteFile.video.contentType, "video/mp4")
        XCTAssertEqual(RemoteFile.thumbnail.contentType, "image/jpeg")
        XCTAssertEqual(RemoteFile.meta.contentType, "application/json")
        XCTAssertEqual(RemoteFile.transcriptText.contentType, "text/plain; charset=utf-8")
    }

    func testEncodedObjectNameKeepsUnreserved() {
        XCTAssertEqual(ShareLinks.encodedObjectName("a-b_c.d~e/f g"), "a-b_c.d~e%2Ff%20g")
    }
}
