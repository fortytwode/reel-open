import XCTest
@testable import ReelCore

final class StorageRequestsTests: XCTestCase {
    let id = "abcdefghij0123456789"
    let base = "https://firebasestorage.googleapis.com/v0/b/demo-reel.firebasestorage.app/o"
    var sut: StorageRequests { StorageRequests(config: testOrganization, auth: .firebase(idToken: "tok"), ownerUID: "uid-1") }

    func testMultipartUpload() throws {
        let req = sut.multipartUpload(shareID: id, file: .video, data: Data("BYTES".utf8), boundary: "BND")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.absoluteString, "\(base)?name=reel%2Fv%2F\(id)%2Fvideo.mp4")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Firebase tok")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Goog-Upload-Protocol"), "multipart")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "multipart/related; boundary=BND")
        let body = String(decoding: try XCTUnwrap(req.httpBody), as: UTF8.self)
        XCTAssertTrue(body.hasPrefix("--BND\r\n"))
        XCTAssertTrue(body.hasSuffix("\r\n--BND--"))
        XCTAssertTrue(body.contains("\"ownerUid\":\"uid-1\""))
        XCTAssertTrue(body.contains("\"contentType\":\"video\\/mp4\"") || body.contains("\"contentType\":\"video/mp4\""))
        XCTAssertTrue(body.contains("BYTES"))
    }

    func testBearerAuth() {
        let s = StorageRequests(config: testOrganization, auth: .bearer(accessToken: "abc"), ownerUID: "u")
        XCTAssertEqual(s.delete(shareID: id, file: .meta).value(forHTTPHeaderField: "Authorization"), "Bearer abc")
    }

    func testResumableStart() throws {
        let req = sut.resumableStart(shareID: id, file: .video, totalBytes: 12345)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.absoluteString, "\(base)?name=reel%2Fv%2F\(id)%2Fvideo.mp4")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Goog-Upload-Protocol"), "resumable")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Goog-Upload-Command"), "start")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Goog-Upload-Header-Content-Length"), "12345")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Goog-Upload-Header-Content-Type"), "video/mp4")
        let json = try JSONSerialization.jsonObject(with: XCTUnwrap(req.httpBody)) as? [String: Any]
        XCTAssertEqual(json?["name"] as? String, "reel/v/\(id)/video.mp4")
        XCTAssertEqual((json?["metadata"] as? [String: String])?["ownerUid"], "uid-1")
        XCTAssertEqual(json?["cacheControl"] as? String, "public, max-age=3600")
    }

    func testResumableChunk() {
        let url = URL(string: "https://example.com/session")!
        let mid = StorageRequests.resumableChunk(sessionURL: url, offset: 8_388_608, chunk: Data([1, 2]), isFinal: false)
        XCTAssertEqual(mid.value(forHTTPHeaderField: "X-Goog-Upload-Command"), "upload")
        XCTAssertEqual(mid.value(forHTTPHeaderField: "X-Goog-Upload-Offset"), "8388608")
        XCTAssertEqual(mid.httpBody, Data([1, 2]))
        let last = StorageRequests.resumableChunk(sessionURL: url, offset: 0, chunk: Data(), isFinal: true)
        XCTAssertEqual(last.value(forHTTPHeaderField: "X-Goog-Upload-Command"), "upload, finalize")
    }

    func testResumableQuery() {
        let r = StorageRequests.resumableQuery(sessionURL: URL(string: "https://example.com/s")!)
        XCTAssertEqual(r.value(forHTTPHeaderField: "X-Goog-Upload-Command"), "query")
    }

    func testDelete() {
        let req = sut.delete(shareID: id, file: .thumbnail)
        XCTAssertEqual(req.httpMethod, "DELETE")
        XCTAssertEqual(req.url?.absoluteString, "\(base)/reel%2Fv%2F\(id)%2Fthumb.jpg")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Firebase tok")
    }

    func testChunkRangesCoverTotalContiguously() {
        let chunk = StorageRequests.defaultChunkSize
        XCTAssertEqual(chunk, 8 * 1024 * 1024)
        let total = Int64(chunk) * 2 + 123
        let r = StorageRequests.chunkRanges(total: total)
        XCTAssertEqual(r.count, 3)
        XCTAssertEqual(r.first?.lowerBound, 0)
        XCTAssertEqual(r.last?.upperBound, total)
        for (a, b) in zip(r, r.dropFirst()) { XCTAssertEqual(a.upperBound, b.lowerBound) }
        XCTAssertEqual(r[0].count, chunk)
    }

    func testChunkRangesEdgeCases() {
        XCTAssertEqual(StorageRequests.chunkRanges(total: 0), [0..<0])
        XCTAssertEqual(StorageRequests.chunkRanges(total: 10), [0..<10])
        let chunk = Int64(StorageRequests.defaultChunkSize)
        XCTAssertEqual(StorageRequests.chunkRanges(total: chunk), [0..<chunk])
    }

    func testCacheControl() {
        XCTAssertEqual(StorageRequests.cacheControl(for: .meta), "no-cache")
        XCTAssertEqual(StorageRequests.cacheControl(for: .transcriptJSON), "no-cache")
        XCTAssertEqual(StorageRequests.cacheControl(for: .transcriptText), "no-cache")
        XCTAssertEqual(StorageRequests.cacheControl(for: .video), "public, max-age=3600")
        XCTAssertEqual(StorageRequests.cacheControl(for: .thumbnail), "public, max-age=3600")
    }
}
