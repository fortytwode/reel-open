import XCTest
@testable import ReelCore

/// Golden vectors shared with the browser recorder (web/reel/core.js). This test computes them
/// with ReelCore and compares them with Tests/CrossClient/cross-client.json; the JS test
/// (firebase/tests/core.test.mjs) checks its own output against the same file, so the Mac app and
/// the web recorder provably build the same Storage paths, object metadata, meta.json, locked
/// stub, Firestore room documents and HLS playlists.
/// Regenerate after an intentional change: REEL_WRITE_FIXTURES=1 swift test --filter CrossClientFixtureTests
final class CrossClientFixtureTests: XCTestCase {
    static let fixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("CrossClient/cross-client.json")

    static let id = "abcdefghij0123456789"
    static let key = "0123456789abcdef0123456789abcdef"
    static let created = Date(timeIntervalSince1970: 1_792_576_800)          // 2026-10-21T10:00:00Z
    static let expiry = Date(timeIntervalSince1970: 1_800_000_000.5)

    static func json(_ data: Data?) -> Any { data.flatMap { try? JSONSerialization.jsonObject(with: $0, options: [.fragmentsAllowed]) } ?? NSNull() }

    static func describe(_ r: URLRequest) -> [String: Any] {
        var out: [String: Any] = ["method": r.httpMethod ?? "GET", "url": r.url?.absoluteString ?? ""]
        out["headers"] = (r.allHTTPHeaderFields ?? [:])
        return out
    }

    /// The JSON metadata part and the trailing bytes of a multipart upload body.
    static func multipartParts(_ body: Data, boundary: String) -> (metadata: Any, payload: String) {
        let s = String(decoding: body, as: UTF8.self)
        let head = "--\(boundary)\r\nContent-Type: application/json; charset=utf-8\r\n\r\n"
        let mid = s.range(of: "\r\n--\(boundary)\r\nContent-Type: ")!
        let metadata = String(s[s.index(s.startIndex, offsetBy: head.count)..<mid.lowerBound])
        return (json(Data(metadata.utf8)), String(s[mid.lowerBound...]))
    }

    static func recordingOpen() -> Recording {
        var r = Recording(id: "LOCAL-1", shareID: id, title: "Q3 plan – v2", createdAt: created, durationSeconds: 61.5, width: 1920, height: 1080,
                          mode: .screen, folderName: "2026-10-21 100000 abcdef", upload: .uploaded, transcriptStatus: .ready, hasThumbnail: true)
        r.playback = PlaybackState(hls: true, mp4: true)
        r.trim = TrimRange(start: 5, end: 20.25)
        r.trimmedUploaded = true
        r.summary = "A short summary."
        r.chapters = [Chapter(start: 0, title: "Intro"), Chapter(start: 30, title: "Demo")]
        r.access = ShareAccess(location: .open, passwordSalt: nil, expiresAt: expiry)
        r.captureState = .complete
        r.titleIsCustom = true
        return r
    }

    static func recordingStarting() -> Recording {
        var r = Recording(id: "LOCAL-2", shareID: id, title: "Recording – 21 Oct 2026, 10:00", createdAt: created, durationSeconds: 0, width: 1670, height: 1080,
                          mode: .window, folderName: "2026-10-21 100000 abcdef", upload: .uploading)
        r.captureState = .recording
        return r
    }

    static func recordingKeyed() -> Recording {
        var r = Recording(id: "LOCAL-3", shareID: id, title: "Secret", createdAt: created, durationSeconds: 8.08, width: 1280, height: 720,
                          mode: .camera, folderName: "f", upload: .failed("HTTP 503"), transcriptStatus: .failed, hasThumbnail: true)
        r.playback = PlaybackState(hls: false, mp4: true)
        r.access = ShareAccess(location: .keyed(key), passwordSalt: "00112233445566778899aabbccddeeff", expiresAt: nil)
        r.captureState = .recovered
        return r
    }

    static func vectors() throws -> [String: Any] {
        var v: [String: Any] = [:]
        let enc = ReelJSON.encoder
        func text(_ d: Data) -> String { String(decoding: d, as: UTF8.self) }

        // meta.json / stub / recording.json, exact bytes
        v["metaOpenReady"] = text(try enc.encode(RemoteMeta(recording: recordingOpen(), status: "ready", ownerName: "Sam", app: "Reel 1.1.0")))
        v["metaStartingRecording"] = text(try enc.encode(RemoteMeta(recording: recordingStarting(), status: "recording", ownerName: nil, app: "Reel 1.1.0")))
        v["metaKeyedProcessing"] = text(try enc.encode(RemoteMeta(recording: recordingKeyed(), status: "processing", ownerName: "sam@northwind.example", app: "Reel 1.1.0")))
        v["lockedStub"] = text(try enc.encode(LockedStub(shareID: id, salt: "00112233445566778899aabbccddeeff", expiresAt: expiry, status: "ready")))
        v["recordingJSONOpen"] = text(try enc.encode(recordingOpen()))
        v["recordingJSONKeyed"] = text(try enc.encode(recordingKeyed()))
        v["recordingJSONStarting"] = text(try enc.encode(recordingStarting()))

        // Storage requests
        let s = StorageRequests(config: testOrganization, auth: .firebase(idToken: "tok"), ownerUID: "uid-1")
        var uploads: [[String: Any]] = []
        let cases: [(RemoteFile, RemoteLocation, StorageRequests.ObjectOptions)] = [
            (.meta, .open, .none),
            (.segment(3), .open, .init(expiresAt: expiry)),
            (.video, .keyed(key), .init(expiresAt: expiry, contentDisposition: StorageRequests.attachmentDisposition(title: "Q3 plan – v2"))),
            (.playlist, .open, .none), (.initSegment, .open, .none), (.thumbnail, .keyed(key), .none),
            (.transcriptText, .open, .none), (.trimmed, .open, .init(contentDisposition: "attachment; filename=\"x.mp4\"")),
        ]
        for (file, loc, opts) in cases {
            let r = s.multipartUpload(shareID: id, file: file, location: loc, data: Data("BYTES".utf8), options: opts, boundary: "BND")
            let parts = multipartParts(r.httpBody!, boundary: "BND")
            var d = describe(r)
            d["file"] = file.rawValue
            d["key"] = loc.isKeyed ? key : NSNull()
            d["expiresAt"] = opts.expiresAt.map { $0.timeIntervalSince1970 * 1000 } ?? NSNull()
            d["contentDisposition"] = opts.contentDisposition ?? NSNull()
            d["metadata"] = parts.metadata
            d["payload"] = parts.payload
            uploads.append(d)
        }
        v["multipartUploads"] = uploads
        let start = s.resumableStart(shareID: id, file: .video, location: .keyed(key), totalBytes: 12_345_678,
                                     options: .init(expiresAt: expiry, contentDisposition: "attachment; filename=\"a.mp4\""))
        v["resumableStart"] = describe(start).merging(["body": json(start.httpBody)]) { $1 }
        v["resumableChunkMid"] = describe(StorageRequests.resumableChunk(sessionURL: URL(string: "https://example.com/session")!, offset: 8_388_608, chunk: Data([1]), isFinal: false))
        v["resumableChunkLast"] = describe(StorageRequests.resumableChunk(sessionURL: URL(string: "https://example.com/session")!, offset: 0, chunk: Data(), isFinal: true))
        let setExp = s.updateMetadata(shareID: id, file: .segment(12), location: .open, expiresAt: expiry)
        v["updateMetadataSet"] = describe(setExp).merging(["body": json(setExp.httpBody)]) { $1 }
        let clearExp = s.updateMetadata(shareID: id, file: .meta, location: .keyed(key), expiresAt: nil)
        v["updateMetadataClear"] = describe(clearExp).merging(["body": json(clearExp.httpBody)]) { $1 }
        v["getMetadata"] = describe(s.getMetadata(shareID: id, file: .thumbnail, location: .keyed(key)))
        v["deleteObject"] = describe(s.delete(shareID: id, file: .segment(1)))
        v["chunkRanges"] = StorageRequests.chunkRanges(total: Int64(StorageRequests.defaultChunkSize) * 2 + 123).map { [$0.lowerBound, $0.upperBound] }
        v["cacheControl"] = Dictionary(uniqueKeysWithValues: (RemoteFile.fixedFiles + [.segment(1)]).map { ($0.rawValue, StorageRequests.cacheControl(for: $0)) })
        v["contentTypes"] = Dictionary(uniqueKeysWithValues: (RemoteFile.fixedFiles + [.segment(1)]).map { ($0.rawValue, $0.contentType) })
        v["dispositions"] = ["Q3 plan – v2", "\"evil\"\r\nX: y", "😀", "Weekly sync (draft), v1.2_final"].map { ["title": $0, "value": StorageRequests.attachmentDisposition(title: $0)] }
        v["encodedObjectNames"] = ["a-b_c.d~e/f g", "reel/v/\(id)/k/\(key)/seg00001.m4s", "ü+&?"].map { ["path": $0, "value": ShareLinks.encodedObjectName($0)] }
        v["downloadURLs"] = [
            ShareLinks.downloadURL(shareID: id, file: .meta, config: testOrganization).absoluteString,
            ShareLinks.downloadURL(shareID: id, file: .playlist, location: .keyed(key), config: testOrganization).absoluteString,
        ]
        v["viewerURL"] = ShareLinks.viewerURL(shareID: id, config: testOrganization).absoluteString
        v["rooms"] = [RemoteLocation.open.room(shareID: id), RemoteLocation.keyed(key).room(shareID: id)]

        // Firestore requests
        let f = FirestoreRequests(config: testOrganization, idToken: "tok")
        let room1 = f.createRoom(id, ownerUID: "uid-1", createdAt: created, expiresAt: nil)
        let room2 = f.createRoom("\(id)-\(key)", ownerUID: "uid-1", createdAt: Date(timeIntervalSince1970: 1_792_576_800.25), views: 7, expiresAt: expiry)
        v["firestoreCreateRoom"] = describe(room1).merging(["body": json(room1.httpBody)]) { $1 }
        v["firestoreCreateRoomKeyed"] = describe(room2).merging(["body": json(room2.httpBody)]) { $1 }
        let exp = f.setRoomExpiry(id, expiresAt: expiry)
        v["firestoreSetExpiry"] = describe(exp).merging(["body": json(exp.httpBody)]) { $1 }
        let noExp = f.setRoomExpiry(id, expiresAt: nil)
        v["firestoreClearExpiry"] = describe(noExp).merging(["body": json(noExp.httpBody)]) { $1 }
        v["firestoreGetRoom"] = describe(f.getRoom(id))
        v["firestoreList"] = describe(f.list(id, collection: "comments", pageToken: "abc/def+=="))
        let migrated = f.create(id, collection: "comments", fields: ["text": .string("hi"), "t": .double(1.5), "migrated": .bool(true), "createdAt": .timestamp(created), "photoURL": .null])
        v["firestoreCreateComment"] = describe(migrated).merging(["body": json(migrated.httpBody)]) { $1 }
        v["firestoreDeleteRoom"] = describe(f.delete(room: id))
        v["firestoreDeleteDoc"] = describe(f.delete(room: id, documentName: "projects/p/databases/reel/documents/videos/x/comments/c"))

        // HLS
        let segs = [SegmentEntry(index: 2, duration: 4.0, bytes: 1), SegmentEntry(index: 1, duration: 4.02, bytes: 1), SegmentEntry(index: 3, duration: 2.5, bytes: 1)]
        v["playlistVOD"] = HLSPlaylist.make(segments: segs, ended: true) { ShareLinks.downloadURL(shareID: id, file: $0, config: testOrganization).absoluteString }
        v["playlistEvent"] = HLSPlaylist.make(segments: Array(segs.prefix(2)), ended: false) { ShareLinks.downloadURL(shareID: id, file: $0, location: .keyed(key), config: testOrganization).absoluteString }

        // Recording helpers
        let utc = TimeZone(identifier: "UTC")!
        v["defaultTitleUTC"] = Recording.defaultTitle(for: created, timeZone: utc)
        v["defaultTitleTokyo"] = Recording.defaultTitle(for: created, timeZone: TimeZone(identifier: "Asia/Tokyo")!)
        v["folderNameUTC"] = Recording.folderName(for: Date(timeIntervalSince1970: 1_792_600_202), shareID: id, timeZone: utc)
        v["trims"] = [[-3, 5, 10], [2, 99, 10], [0, 10, 10], [5, 5.2, 10], [6, 2, 10], [1.23456, 7.89012, 10], [0.04, 9.96, 10]].map { c -> [String: Any] in
            let t = TrimRange.normalized(start: c[0], end: c[1], duration: c[2])
            return ["in": c, "out": t.map { [$0.start, $0.end] as Any } ?? NSNull()]
        }
        v["expiryString"] = StorageRequests.expiryString(expiry)

        // Access keys
        v["pbkdf2"] = [
            ["password": "passwd", "salt": AccessKey.hex(Array("salt".utf8)), "iterations": 1, "key": AccessKey.derive(password: "passwd", saltHex: AccessKey.hex(Array("salt".utf8)), iterations: 1)!],
            ["password": "hunter2", "salt": "00112233445566778899aabbccddeeff", "iterations": AccessKey.iterations, "key": AccessKey.derive(password: "hunter2", saltHex: "00112233445566778899aabbccddeeff")!],
            ["password": "pässwörd 🔒", "salt": "ffeeddccbbaa99887766554433221100", "iterations": 1000, "key": AccessKey.derive(password: "pässwörd 🔒", saltHex: "ffeeddccbbaa99887766554433221100", iterations: 1000)!],
        ]

        // Geometry
        v["outputSizes"] = [[3456, 2234, "p1080"], [800, 600, "p1080"], [801, 601, "p1080"], [3840, 2160, "p720"], [2160, 3840, "p1080"], [5120, 2880, "p2160"]].map { c -> [String: Any] in
            let o = VideoGeometry.outputSize(source: PixelSize(width: c[0] as! Int, height: c[1] as! Int), preset: QualityPreset(rawValue: c[2] as! String)!)
            return ["in": c, "out": [o.width, o.height]]
        }
        v["bitrates"] = [[1920, 1080, 30], [1670, 1080, 30], [100, 100, 30], [1280, 720, 30], [2560, 1440, 24], [3840, 2160, 30], [1920, 1080, 60]].map {
            ["in": $0, "out": VideoGeometry.bitrate(for: PixelSize(width: $0[0], height: $0[1]), fps: $0[2])]
        }
        let corner = VideoGeometry.cornerBubble(output: PixelSize(width: 1920, height: 1080))
        v["cornerBubble1080"] = [corner.x, corner.y, corner.width, corner.height]
        return v
    }

    static func serialize(_ v: [String: Any]) throws -> Data {
        var d = try JSONSerialization.data(withJSONObject: v, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        d.append(Data("\n".utf8))
        return d
    }

    func testCrossClientFixtureIsCurrent() throws {
        let fresh = try Self.serialize(Self.vectors())
        if ProcessInfo.processInfo.environment["REEL_WRITE_FIXTURES"] == "1" {
            try FileManager.default.createDirectory(at: Self.fixtureURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fresh.write(to: Self.fixtureURL)
        }
        let stored = try Data(contentsOf: Self.fixtureURL)
        // Compare parsed values, so formatting of the fixture file itself doesn't matter.
        let a = try JSONSerialization.jsonObject(with: fresh) as! NSDictionary
        let b = try JSONSerialization.jsonObject(with: stored) as! NSDictionary
        for k in a.allKeys as! [String] {
            XCTAssertEqual(a[k] as? NSObject, b[k] as? NSObject, "cross-client vector \(k) changed; regenerate with REEL_WRITE_FIXTURES=1 and update web/reel/core.js")
        }
        XCTAssertEqual(Set(a.allKeys as! [String]), Set(b.allKeys as! [String]))
    }
}
