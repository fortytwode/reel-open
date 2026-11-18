import XCTest
@testable import ReelCore

final class SharedMeetingNoteTests: XCTestCase {
    private let id = "reel_" + String(repeating: "a", count: 64)

    private func payload(date: String = "2026-11-16T10:00:00Z", extra: String = "") -> Data {
        Data("""
        {"id":"\(id)","title":"Call","started_at":"\(date)","duration_seconds":65.5,
         "attendees":["a@example.com"],"recipients":["a@example.com"],"summary":"Notes",
         "transcript_status":"complete","local_recording_ids":["local"]\(extra)}
        """.utf8)
    }

    func testIndexAndDetailDecodeISO8601DatesAndIgnoreUnknownFields() throws {
        let index = try JSONDecoder().decode(SharedMeetingNote.self, from: payload())
        let detail = try JSONDecoder().decode(SharedMeetingNote.self, from: payload(date: "2026-11-16T10:00:00.125Z", extra: ",\"transcript_text\":\"hello\",\"segments\":[{}],\"notes_url\":\"https://untrusted.example\""))
        XCTAssertNil(index.transcriptText)
        XCTAssertEqual(detail.transcriptText, "hello")
        XCTAssertEqual(detail.startedAt.timeIntervalSince(index.startedAt), 0.125, accuracy: 0.001)
        XCTAssertEqual(index.localRecordingIDs, ["local"])
    }

    func testInvalidIDsAndIncompletePayloadRejected() throws {
        XCTAssertTrue(SharedMeetingNote.isValidRemoteID(id))
        for invalid in ["reel_" + String(repeating: "A", count: 64), id + "/x", "reel_short"] {
            XCTAssertFalse(SharedMeetingNote.isValidRemoteID(invalid))
            XCTAssertThrowsError(try JSONDecoder().decode(SharedMeetingNote.self, from: Data(String(decoding: payload(), as: UTF8.self).replacingOccurrences(of: id, with: invalid).utf8)))
        }
        XCTAssertThrowsError(try JSONDecoder().decode(SharedMeetingNote.self, from: Data("{}".utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(SharedMeetingNote.self, from: payload(date: "invalid")))
    }

    func testLocalHistoryRequiresMatchingOwnerAndDeduplicatesSharedRecordings() throws {
        let shared = try JSONDecoder().decode(SharedMeetingNote.self, from: payload())
        func recording(_ id: String, _ owner: String?, meeting: Bool = true) -> Recording {
            Recording(id: id, title: id, createdAt: Date(), durationSeconds: 0, width: 0, height: 0, mode: .screen, folderName: id, meeting: meeting ? MeetingDetails(ownerUserID: owner) : nil)
        }
        let records = [recording("local", "owner"), recording("own", "owner"), recording("other", "other"), recording("legacy", nil), recording("video", "owner", meeting: false)]
        XCTAssertEqual(MeetingWorkspaceHistory.localRecordings(records, ownerUserID: "owner", shared: [shared]).map(\.id), ["own"])
        XCTAssertTrue(MeetingWorkspaceHistory.localRecordings(records, ownerUserID: nil, shared: []).isEmpty)
        XCTAssertTrue(MeetingWorkspaceHistory.localRecordings(records, ownerUserID: "", shared: []).isEmpty)
    }

    func testDeliveryAPILowercaseUUIDDoesNotDuplicateTheMacRecording() throws {
        let recordingID = "B9C4A1AE-CB3B-4415-BA34-EA432FC76D70"
        let json = String(decoding: payload(), as: UTF8.self)
            .replacingOccurrences(of: "\"local\"", with: "\"\(recordingID.lowercased())\"")
        let shared = try JSONDecoder().decode(SharedMeetingNote.self, from: Data(json.utf8))
        let recording = Recording(id: recordingID, title: "Call", createdAt: Date(), durationSeconds: 65.5,
                                  width: 0, height: 0, mode: .screen, folderName: "call",
                                  meeting: MeetingDetails(ownerUserID: "owner"))
        XCTAssertTrue(MeetingWorkspaceHistory.localRecordings([recording], ownerUserID: "owner", shared: [shared]).isEmpty)
    }
}
