import XCTest
@testable import ReelCore

final class SharingTests: XCTestCase {
    let id = "abcdefghij0123456789"
    let key = "0123456789abcdef0123456789abcdef"

    // MARK: AccessKey

    func testPBKDF2KnownVector() {
        // RFC 7914 §11: PBKDF2-HMAC-SHA256, P="passwd", S="salt", c=1 → 55ac046e56e3089f…
        let salt = AccessKey.hex(Array("salt".utf8))
        XCTAssertEqual(AccessKey.derive(password: "passwd", saltHex: salt, iterations: 1, length: 16), "55ac046e56e3089fec1691c22544b605")
    }

    func testDeriveIsDeterministicAndSaltDependent() throws {
        let s1 = "00112233445566778899aabbccddeeff", s2 = "ffeeddccbbaa99887766554433221100"
        let a = try XCTUnwrap(AccessKey.derive(password: "hunter2", saltHex: s1, iterations: 1000))
        XCTAssertEqual(a, AccessKey.derive(password: "hunter2", saltHex: s1, iterations: 1000))
        XCTAssertNotEqual(a, AccessKey.derive(password: "hunter2", saltHex: s2, iterations: 1000))
        XCTAssertNotEqual(a, AccessKey.derive(password: "hunter3", saltHex: s1, iterations: 1000))
        XCTAssertTrue(AccessKey.isValidKey(a))
        XCTAssertNil(AccessKey.derive(password: "", saltHex: s1))
        XCTAssertNil(AccessKey.derive(password: "x", saltHex: "zz"))
    }

    func testSaltShape() {
        let s = AccessKey.newSalt()
        XCTAssertEqual(s.count, 32)
        XCTAssertEqual(AccessKey.bytes(fromHex: s)?.count, 16)
        XCTAssertNotEqual(s, AccessKey.newSalt())
    }

    func testIsValidKey() {
        XCTAssertTrue(AccessKey.isValidKey(key))
        XCTAssertFalse(AccessKey.isValidKey(key.uppercased()))
        XCTAssertFalse(AccessKey.isValidKey(String(key.dropLast())))
    }

    // MARK: Locations and files

    func testLocations() {
        XCTAssertEqual(ShareLinks.objectPath(shareID: id, file: .video), "reel/v/\(id)/video.mp4")
        XCTAssertEqual(ShareLinks.objectPath(shareID: id, file: .video, location: .keyed(key)), "reel/v/\(id)/k/\(key)/video.mp4")
        XCTAssertEqual(RemoteLocation.open.room(shareID: id), id)
        XCTAssertEqual(RemoteLocation.keyed(key).room(shareID: id), "\(id)-\(key)")
        XCTAssertEqual(ShareLinks.downloadURL(shareID: id, file: .playlist, location: .keyed(key), config: testOrganization).absoluteString,
                       "https://firebasestorage.googleapis.com/v0/b/demo-reel.firebasestorage.app/o/reel%2Fv%2F\(id)%2Fk%2F\(key)%2Fvideo.m3u8?alt=media")
    }

    func testRemoteFilesMatchRulesAllowList() {
        for f in RemoteFile.fixedFiles + [.segment(1), .segment(99_999), .segment(123_456)] {
            XCTAssertTrue(f.isAllowedByRules, f.rawValue)
        }
        XCTAssertFalse(RemoteFile(rawValue: "evil.html").isAllowedByRules)
        XCTAssertFalse(RemoteFile(rawValue: "seg1.m4s").isAllowedByRules)
        XCTAssertEqual(RemoteFile.segment(7).rawValue, "seg00007.m4s")
        XCTAssertTrue(RemoteFile.segment(7).isSegment)
        XCTAssertEqual(RemoteFile.playlist.contentType, "application/vnd.apple.mpegurl")
        XCTAssertEqual(RemoteFile.segment(1).contentType, "video/iso.segment")
        XCTAssertEqual(RemoteFile.initSegment.contentType, "video/mp4")
        XCTAssertEqual(StorageRequests.cacheControl(for: .playlist), "no-cache")
        XCTAssertEqual(StorageRequests.cacheControl(for: .segment(3)), "public, max-age=3600")
    }

    // MARK: Storage requests

    var sut: StorageRequests { StorageRequests(config: testOrganization, auth: .firebase(idToken: "tok"), ownerUID: "uid-1") }

    func testUploadCarriesExpiryAndDisposition() throws {
        let expiry = Date(timeIntervalSince1970: 1_800_000_000.5)
        let req = sut.multipartUpload(shareID: id, file: .video, location: .keyed(key), data: Data("X".utf8),
                                      options: .init(expiresAt: expiry, contentDisposition: "attachment; filename=\"a.mp4\""), boundary: "B")
        XCTAssertEqual(req.url?.absoluteString, "https://firebasestorage.googleapis.com/v0/b/demo-reel.firebasestorage.app/o?name=reel%2Fv%2F\(id)%2Fk%2F\(key)%2Fvideo.mp4")
        let body = String(decoding: try XCTUnwrap(req.httpBody), as: UTF8.self)
        XCTAssertTrue(body.contains("\"expiresAt\":\"1800000000500\""), body)
        XCTAssertTrue(body.contains("\"contentDisposition\":\"attachment; filename=\\\"a.mp4\\\"\""), body)
    }

    func testUpdateMetadataSetsAndClearsExpiry() throws {
        let set = sut.updateMetadata(shareID: id, file: .meta, expiresAt: Date(timeIntervalSince1970: 1000))
        XCTAssertEqual(set.httpMethod, "PATCH")
        XCTAssertEqual(set.url?.absoluteString, "https://firebasestorage.googleapis.com/v0/b/demo-reel.firebasestorage.app/o/reel%2Fv%2F\(id)%2Fmeta.json")
        let j = try JSONSerialization.jsonObject(with: XCTUnwrap(set.httpBody)) as? [String: [String: Any]]
        XCTAssertEqual(j?["metadata"]?["expiresAt"] as? String, "1000000")
        XCTAssertEqual(j?["metadata"]?["ownerUid"] as? String, "uid-1")
        let clear = sut.updateMetadata(shareID: id, file: .meta, expiresAt: nil)
        let k = try JSONSerialization.jsonObject(with: XCTUnwrap(clear.httpBody)) as? [String: [String: Any]]
        XCTAssertTrue(k?["metadata"]?["expiresAt"] is NSNull)
    }

    func testAttachmentDispositionIsSafe() {
        XCTAssertEqual(StorageRequests.attachmentDisposition(title: "Q3 plan – v2"), "attachment; filename=\"Q3 plan - v2.mp4\"")
        XCTAssertEqual(StorageRequests.attachmentDisposition(title: "\"evil\"\r\nX: y"), "attachment; filename=\"-evil-X- y.mp4\"")
        XCTAssertEqual(StorageRequests.attachmentDisposition(title: "😀"), "attachment; filename=\"Reel recording.mp4\"")
    }

    // MARK: Meta

    func recording() -> Recording {
        var r = Recording(shareID: id, title: "Demo", createdAt: Date(timeIntervalSince1970: 0), durationSeconds: 61, width: 1920, height: 1080, mode: .area, folderName: "f")
        r.playback = PlaybackState(hls: true, mp4: false)
        return r
    }

    func testRemoteMetaV2EncodesAllKeys() throws {
        var r = recording()
        r.trim = TrimRange(start: 1, end: 50)
        r.summary = "S"
        r.chapters = [Chapter(start: 0, title: "Intro")]
        let data = try ReelJSON.encoder.encode(RemoteMeta(recording: r, status: "ready", ownerName: "Sam", app: "Reel"))
        let j = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(j["schemaVersion"] as? Int, 2)
        XCTAssertEqual((j["playback"] as? [String: Bool])?["hls"], true)
        XCTAssertEqual((j["trim"] as? [String: Double])?["end"], 50)
        XCTAssertTrue(j["download"] is NSNull)   // trimmed copy not uploaded, no mp4 yet
        XCTAssertTrue(j["expiresAt"] is NSNull)
        XCTAssertEqual(j["locked"] as? Bool, false)
        XCTAssertEqual(j["room"] as? String, id)
        XCTAssertEqual(j["summary"] as? String, "S")
    }

    func testDownloadFile() {
        var r = recording()
        XCTAssertNil(r.downloadFile)
        r.playback.mp4 = true
        XCTAssertEqual(r.downloadFile, .video)
        r.trim = TrimRange(start: 1, end: 2)
        XCTAssertEqual(r.downloadFile, .video)
        r.trimmedUploaded = true
        XCTAssertEqual(r.downloadFile, .trimmed)
    }

    func testLockedStubHasNoTitle() throws {
        let stub = LockedStub(shareID: id, salt: "00", expiresAt: nil, status: "ready")
        let j = try XCTUnwrap(JSONSerialization.jsonObject(with: ReelJSON.encoder.encode(stub)) as? [String: Any])
        XCTAssertEqual(j["locked"] as? Bool, true)
        XCTAssertNil(j["title"])
        let kdf = try XCTUnwrap(j["kdf"] as? [String: Any])
        XCTAssertEqual(kdf["iterations"] as? Int, 210_000)
        XCTAssertEqual(kdf["keyBytes"] as? Int, 16)
        XCTAssertEqual(kdf["hash"] as? String, "SHA-256")
    }

    func testRecordingDecodesLegacyJSONWithDefaults() throws {
        let legacy = """
        {"id":"x","shareID":"\(id)","title":"T","createdAt":"2026-10-21T10:00:00Z","durationSeconds":3,"width":10,"height":10,
         "mode":"screen","folderName":"f","upload":{"uploaded":{}},"transcriptStatus":"ready","hasThumbnail":true}
        """
        let r = try ReelJSON.decoder.decode(Recording.self, from: Data(legacy.utf8))
        XCTAssertEqual(r.upload, .uploaded)
        XCTAssertEqual(r.captureState, .complete)
        XCTAssertEqual(r.access, ShareAccess())
        XCTAssertNil(r.trim)
        XCTAssertFalse(r.titleIsCustom)
    }

    func testRecordingRoundTripWithNewFields() throws {
        var r = recording()
        r.access = ShareAccess(location: .keyed(key), passwordSalt: "aa", expiresAt: Date(timeIntervalSince1970: 100))
        r.trim = TrimRange(start: 1, end: 9)
        r.captureState = .recovered
        r.chapters = [Chapter(start: 0, title: "A")]
        r.titleIsCustom = true
        XCTAssertEqual(try ReelJSON.decoder.decode(Recording.self, from: ReelJSON.encoder.encode(r)), r)
        XCTAssertEqual(r.room, "\(id)-\(key)")
    }

    // MARK: Trim and expiry

    func testTrimNormalization() {
        XCTAssertEqual(TrimRange.normalized(start: -3, end: 5, duration: 10), TrimRange(start: 0, end: 5))
        XCTAssertEqual(TrimRange.normalized(start: 2, end: 99, duration: 10), TrimRange(start: 2, end: 10))
        XCTAssertNil(TrimRange.normalized(start: 0, end: 10, duration: 10))       // nothing trimmed
        XCTAssertNil(TrimRange.normalized(start: 5, end: 5.2, duration: 10))      // too short
        XCTAssertNil(TrimRange.normalized(start: 6, end: 2, duration: 10))
        XCTAssertNil(TrimRange.normalized(start: .nan, end: 2, duration: 10))
        XCTAssertTrue(TrimRange(start: 1, end: 2).contains(1.5))
    }

    func testExpiryOptions() {
        let now = Date(timeIntervalSince1970: 0)
        XCTAssertNil(ExpiryOption.never.date(from: now))
        XCTAssertEqual(ExpiryOption.day.date(from: now), Date(timeIntervalSince1970: 86_400))
        XCTAssertTrue(ShareAccess(expiresAt: Date(timeIntervalSince1970: 1)).isExpired(now: Date(timeIntervalSince1970: 2)))
        XCTAssertFalse(ShareAccess().isExpired())
    }

    // MARK: Firestore

    func testPrivateLibraryRequestsNeverIncludePasswordMaterial() throws {
        let f = FirestoreRequests(config: testOrganization, idToken: "tok")
        var r = Recording(shareID: id, title: "Private recording", createdAt: Date(timeIntervalSince1970: 0),
                          durationSeconds: 12.5, width: 1920, height: 1080, mode: .screen,
                          folderName: "local", upload: .uploaded)
        r.access = ShareAccess(location: .keyed("0123456789abcdef0123456789abcdef"), passwordSalt: "secret-salt")
        let request = f.upsertLibraryEntry(r, ownerUID: "owner", status: "ready")
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertTrue(request.url!.absoluteString.hasSuffix("/users/owner/recordings/\(id)"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        let fields = try XCTUnwrap(body["fields"] as? [String: Any])
        XCTAssertEqual(Set(fields.keys), Set(["id", "title", "createdAt", "durationSeconds", "status"]))
        XCTAssertFalse(String(data: request.httpBody!, encoding: .utf8)!.contains("secret-salt"))
        XCTAssertEqual(f.deleteLibraryEntry(id, ownerUID: "owner").httpMethod, "DELETE")
    }

    func testFirestoreRequests() throws {
        let f = FirestoreRequests(config: testOrganization, idToken: "tok")
        let create = f.createRoom(id, ownerUID: "u1", createdAt: Date(timeIntervalSince1970: 0), expiresAt: nil)
        XCTAssertEqual(create.url?.absoluteString, "https://firestore.googleapis.com/v1/projects/demo-reel/databases/reel/documents/videos?documentId=\(id)")
        XCTAssertEqual(create.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(create.httpBody)) as? [String: [String: [String: Any]]])
        XCTAssertEqual(body["fields"]?["views"]?["integerValue"] as? String, "0")
        XCTAssertEqual(body["fields"]?["ownerUid"]?["stringValue"] as? String, "u1")
        XCTAssertTrue(body["fields"]?["expiresAt"]?["nullValue"] is NSNull)
        let patch = f.setRoomExpiry(id, expiresAt: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(patch.httpMethod, "PATCH")
        XCTAssertTrue(patch.url!.absoluteString.hasSuffix("videos/\(id)?updateMask.fieldPaths=expiresAt"))
        let titlePatch = f.setRoomTitle(id, title: "Shared web title")
        XCTAssertEqual(titlePatch.httpMethod, "PATCH")
        XCTAssertTrue(titlePatch.url!.absoluteString.hasSuffix("videos/\(id)?updateMask.fieldPaths=titleOverride"))
        let titleBody = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(titlePatch.httpBody)) as? [String: Any])
        XCTAssertEqual(FirestoreRequests.fields(of: titleBody), ["titleOverride": .string("Shared web title")])
        let fields = FirestoreRequests.fields(of: ["fields": ["views": ["integerValue": "12"], "expiresAt": ["timestampValue": "2026-10-21T10:00:00Z"], "x": ["nullValue": NSNull()]]])
        XCTAssertEqual(fields["views"], .int(12))
        XCTAssertEqual(fields["x"], .null)
        if case .timestamp(let d)? = fields["expiresAt"] { XCTAssertEqual(d.timeIntervalSince1970, 1_792_576_800) } else { XCTFail() }
        XCTAssertEqual(f.delete(room: id, documentName: "projects/p/databases/reel/documents/videos/x/comments/c").url?.absoluteString,
                       "https://firestore.googleapis.com/v1/projects/p/databases/reel/documents/videos/x/comments/c")
    }
}
