import XCTest
@testable import ReelCore

final class MeetingTests: XCTestCase {
    func testReviewHoldSurvivesPersistenceWithoutLosingTranscriptOrCachedEnvelope() throws {
        var recording = sample(meeting: MeetingDetails(ownerUserID: "owner"))
        recording.transcriptStatus = .ready
        recording.meeting?.deliveryEnvelope = Data("immutable original body".utf8)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: ReelJSON.encoder.encode(recording)) as? [String: Any])
        var meeting = try XCTUnwrap(object["meeting"] as? [String: Any])
        meeting["deliveryStatus"] = "reviewRequired"
        meeting["summaryReviewPassed"] = false
        object["meeting"] = meeting
        let restored = try ReelJSON.decoder.decode(Recording.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(restored.meeting?.deliveryStatus?.rawValue, "reviewRequired")
        XCTAssertEqual(restored.transcriptStatus, .ready)
        XCTAssertEqual(restored.meeting?.deliveryEnvelope, recording.meeting?.deliveryEnvelope)
        XCTAssertEqual(restored.meeting?.summaryReviewPassed, false)
        XCTAssertEqual(restored.meeting?.mayAutomaticallyProcess, false)
        XCTAssertEqual(restored.meeting?.permitsReviewedDelivery, false)
    }

    func testReviewGateBlocksCachedBodiesButPreservesConfirmedReceiptReconciliation() throws {
        var meeting = MeetingDetails(ownerUserID: "owner")
        meeting.deliveryEnvelope = Data("already prepared body".utf8)
        // Older records without delivery opt-in must not enter the queue.
        XCTAssertFalse(meeting.mayAutomaticallyProcess)
        XCTAssertFalse(meeting.permitsReviewedDelivery)
        meeting.deliveryStatus = .pending
        XCTAssertTrue(meeting.mayAutomaticallyProcess)
        XCTAssertFalse(meeting.permitsReviewedDelivery)
        meeting.summaryReviewPassed = true
        XCTAssertFalse(meeting.permitsReviewedDelivery, "A different transcript review must not approve an old body")
        XCTAssertTrue(meeting.recordEnvelopeReview(for: try XCTUnwrap(meeting.deliveryEnvelope)))
        XCTAssertTrue(meeting.permitsReviewedDelivery)
        let reviewed = try ReelJSON.decoder.decode(MeetingDetails.self, from: ReelJSON.encoder.encode(meeting))
        XCTAssertTrue(reviewed.deliveryEnvelopePassedReview)
        XCTAssertFalse(meeting.recordEnvelopeReview(for: Data("different body".utf8)))
        meeting.deliveryEnvelope = Data("different body".utf8)
        XCTAssertFalse(meeting.permitsReviewedDelivery, "Changing the body invalidates the prior review")
        meeting.summaryReviewPassed = false
        XCTAssertFalse(meeting.mayAutomaticallyProcess)
        XCTAssertFalse(meeting.permitsReviewedDelivery)
        meeting.deliveryReceipt = .init(pageID: "page", url: "https://www.notion.so/page", recipients: [], route: "private", suppressedDuplicate: false)
        XCTAssertFalse(meeting.permitsReviewedDelivery, "A receipt must not bypass an explicit review hold")
        meeting.summaryReviewPassed = nil
        meeting.deliveryStatus = .confirmed
        XCTAssertTrue(meeting.permitsReviewedDelivery, "A legacy confirmed receipt can be reconciled without changing its body")
        XCTAssertFalse(meeting.mayAutomaticallyProcess)
        meeting.deliveryStatus = .reviewRequired
        XCTAssertFalse(meeting.permitsReviewedDelivery)
        XCTAssertFalse(meeting.mayAutomaticallyProcess)
    }

    func testCancelledOrInvalidCalendarAttemptCannotAttachInviteToNextManualMeeting() throws {
        for invalid in [false, true] {
            var occurrence: String? = "selected-calendar-occurrence"
            var reference: MeetingCalendarReference? = .init(icalUID: "selected@google.com", occurrenceStart: "2026-11-10T10:00:00Z")
            if invalid {
                XCTAssertThrowsError(try MeetingCapturePolicy.takeMeeting(attendeeText: "invalid address", ownerUserID: "owner", occurrenceID: &occurrence, calendar: &reference))
            } else {
                // Discarding this snapshot models cancelling the pending capture.
                _ = try MeetingCapturePolicy.takeMeeting(attendeeText: "guest@northwind.example", ownerUserID: "owner", occurrenceID: &occurrence, calendar: &reference)
            }
            let manual = try MeetingCapturePolicy.takeMeeting(attendeeText: "", ownerUserID: "owner", occurrenceID: &occurrence, calendar: &reference)
            XCTAssertNil(manual.calendar)
            XCTAssertNil(manual.calendarOccurrenceID)
        }
    }
    func testDeliveryCalendarAndReceiptSurviveRecordingPersistence() throws {
        let reference = MeetingCalendarReference(icalUID: "event@google.com", occurrenceStart: "2026-11-10T10:00:00Z")
        var meeting = MeetingDetails(attendees: ["invitee@northwind.example"], ownerUserID: "owner")
        meeting.calendar = reference
        meeting.deliveryStatus = .pending
        meeting.deliveryEnvelope = Data(#"{"id":"local-meeting","title":"Original notes"}"#.utf8)
        var recording = sample(meeting: meeting)
        let saved = try ReelJSON.decoder.decode(Recording.self, from: ReelJSON.encoder.encode(recording))
        XCTAssertEqual(saved.meeting?.calendar, reference)
        XCTAssertEqual(saved.meeting?.deliveryStatus, .pending)
        recording.title = "Renamed after an uncertain response"
        recording.meeting?.deliveryReceipt = MeetingDeliveryReceipt(pageID: "page", url: "https://www.notion.so/page",
            recipients: ["invitee@northwind.example"], route: "private", suppressedDuplicate: false)
        recording.meeting?.deliveryStatus = .confirmed
        let delivered = try ReelJSON.decoder.decode(Recording.self, from: ReelJSON.encoder.encode(recording))
        XCTAssertEqual(delivered.meeting?.deliveryReceipt?.recipients, ["invitee@northwind.example"])
        XCTAssertEqual(delivered.meeting?.deliveryEnvelope, meeting.deliveryEnvelope)
        let wire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(reference)) as! [String: String]
        XCTAssertEqual(wire["ical_uid"], "event@google.com")
        XCTAssertEqual(wire["occurrence_start"], "2026-11-10T10:00:00Z")
    }

    func sample(meeting: MeetingDetails? = nil, upload: UploadState = .pending) -> Recording {
        Recording(id: "local-meeting", shareID: "abcdefghij0123456789", title: "Planning call",
                  createdAt: Date(timeIntervalSince1970: 1_793_275_200), durationSeconds: 65,
                  width: 1920, height: 1080, mode: .window, folderName: "meeting-fixture",
                  upload: upload, meeting: meeting)
    }

    func testMeetingCaptureSnapshotOverridesSharingWithoutMutatingNormalPreferences() {
        var normal = ReelSettings()
        normal.mode = .camera
        normal.cameraEnabled = true
        normal.audio = .none
        normal.fps = 60
        normal.autoUpload = true
        normal.liveUpload = true
        normal.copyLinkOnStop = true
        normal.aiSummary = false
        normal.microphoneID = "chosen-microphone"
        let before = normal
        let snapshot = MeetingCapturePolicy.settings(from: normal)
        XCTAssertEqual(normal, before)
        XCTAssertEqual(snapshot.mode, .window)
        XCTAssertFalse(snapshot.cameraEnabled)
        XCTAssertEqual(snapshot.audio, .micAndSystem)
        XCTAssertEqual(snapshot.fps, 15)
        XCTAssertFalse(snapshot.autoUpload)
        XCTAssertFalse(snapshot.liveUpload)
        XCTAssertFalse(snapshot.copyLinkOnStop)
        XCTAssertTrue(snapshot.aiSummary)
        XCTAssertEqual(snapshot.microphoneID, normal.microphoneID)
        XCTAssertEqual(snapshot.quality, normal.quality)
        XCTAssertEqual(snapshot.shortcut, normal.shortcut)
    }

    func testMeetingIntentSurvivesPersistenceAndGlobalSharingChanges() throws {
        let meeting = try MeetingDetails.parse(attendeeText: "Guest@client.test, owner@example.test",
                                               calendarOccurrenceID: "calendar:occurrence-2026-10-29")
        // Even a misleading old upload state cannot override the persisted meeting intent.
        for upload in [UploadState.localOnly, .pending, .uploading, .uploaded, .failed("interrupted")] {
            var recording = sample(meeting: meeting, upload: upload)
            recording.captureState = .recovered
            let restored = try ReelJSON.decoder.decode(Recording.self, from: ReelJSON.encoder.encode(recording))
            var global = ReelSettings()
            global.autoUpload = true
            global.liveUpload = true
            global.copyLinkOnStop = true
            XCTAssertTrue(restored.isMeeting)
            XCTAssertFalse(restored.allowsAutomaticCloudDelivery)
            XCTAssertFalse(restored.permitsPublishing())
            XCTAssertTrue(restored.permitsPublishing(allowMeetingShare: true))
            XCTAssertEqual(restored.meeting, meeting)
            XCTAssertTrue(global.autoUpload)
        }
    }

    func testLegacyRecordingRemainsNormalWhenMeetingFieldIsMissing() throws {
        let encoded = try ReelJSON.encoder.encode(sample())
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        object.removeValue(forKey: "meeting")
        let restored = try ReelJSON.decoder.decode(Recording.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertFalse(restored.isMeeting)
        XCTAssertTrue(restored.allowsAutomaticCloudDelivery)
        XCTAssertTrue(restored.permitsPublishing())
    }

    func testMalformedMeetingContextCannotDecodeAsAutoShareableRecording() throws {
        let encoded = try ReelJSON.encoder.encode(sample(meeting: MeetingDetails(attendees: ["a@example.test"])))
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        object["meeting"] = ["attendees": "not-an-array"]
        XCTAssertThrowsError(try ReelJSON.decoder.decode(Recording.self, from: JSONSerialization.data(withJSONObject: object)))
    }

    func testAttendeeValidationNormalizesExactEmailsAndAllowsBlank() throws {
        XCTAssertEqual(try MeetingDetails.parse(attendeeText: " Guest@Client.test ; owner@example.test\n guest@client.test ").attendees,
                       ["guest@client.test", "owner@example.test"])
        XCTAssertEqual(try MeetingDetails.parse(attendeeText: " \n ; , ").attendees, [])
        XCTAssertThrowsError(try MeetingDetails.parse(attendeeText: "Guest Name <guest@example.test>"))
        XCTAssertThrowsError(try MeetingDetails.parse(attendeeText: "not-an-email"))
        XCTAssertThrowsError(try MeetingDetails.parse(attendeeText: "guest@example.test", calendarOccurrenceID: "bad\nidentity"))
    }

    func testCalendarOccurrenceDeduplicationUsesExactOccurrenceNotTitleOrAttendees() throws {
        let first = sample(meeting: MeetingDetails(attendees: ["owner@example.test"], calendarOccurrenceID: "event:2026-10-29"))
        var next = sample(meeting: MeetingDetails(attendees: ["owner@example.test"], calendarOccurrenceID: "event:2026-11-05"))
        next.id = "next-week"
        let recordings = [first, next]
        XCTAssertEqual(MeetingCapturePolicy.existingOccurrence(in: recordings, id: "event:2026-10-29")?.id, first.id)
        XCTAssertEqual(MeetingCapturePolicy.existingOccurrence(in: recordings, id: "event:2026-11-05")?.id, next.id)
        XCTAssertNil(MeetingCapturePolicy.existingOccurrence(in: recordings, id: "event:unknown"))
        XCTAssertNil(MeetingCapturePolicy.existingOccurrence(in: recordings, id: nil))
    }

    func testAutomaticCaptureRevocationTargetsOnlyOwnedOccurrence() {
        let owned = sample(meeting: MeetingDetails(calendarOccurrenceID: "event:owned", ownerUserID: "owner-a"))
        var other = owned
        other.id = "other"
        other.meeting = MeetingDetails(calendarOccurrenceID: "event:other", ownerUserID: "owner-a")
        let cases: [(String, Bool, Bool, Recording?, String, String?, Bool)] = [
            ("automatic consent revoked", true, false, owned, "event:owned", "owner-a", true),
            ("automatic account switched", true, false, owned, "event:owned", "owner-a", true),
            ("consent still valid", true, true, owned, "event:owned", "owner-a", false),
            ("manual capture", false, false, owned, "event:owned", "owner-a", false),
            ("different occurrence", true, false, other, "event:owned", "owner-a", false),
            ("different owner", true, false, owned, "event:owned", "owner-b", false),
            ("ordinary recording", true, false, sample(), "event:owned", "owner-a", false),
            ("no recording", true, false, nil, "event:owned", "owner-a", false),
        ]
        for (name, automatic, authorized, recording, occurrence, owner, expected) in cases {
            XCTAssertEqual(MeetingCapturePolicy.shouldStopOnRevocation(
                automatic: automatic, authorizationValid: authorized, recording: recording,
                occurrenceID: occurrence, ownerUserID: owner), expected, name)
        }
    }

    func testPrivateAttendeesAndCalendarIdentityAreNotPublicMetadata() throws {
        let recording = sample(meeting: MeetingDetails(attendees: ["private@example.test"], calendarOccurrenceID: "secret-calendar-occurrence"))
        let meta = RemoteMeta(recording: recording, status: "ready", ownerName: "Owner", app: "Reel")
        let data = try ReelJSON.encoder.encode(meta)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(object["meeting"])
        XCTAssertNil(object["attendees"])
        XCTAssertNil(object["calendarOccurrenceID"])
        let raw = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(raw.contains("private@example.test"))
        XCTAssertFalse(raw.contains("secret-calendar-occurrence"))
    }

    func testMetadataOwnerPersistsLocallyAndIsAbsentFromRemoteMeta() throws {
        let owner = "firebase-user-captured-at-start"
        let recording = sample(meeting: MeetingDetails(attendees: ["private@example.test"], ownerUserID: owner))
        let localData = try ReelJSON.encoder.encode(recording)
        let restored = try ReelJSON.decoder.decode(Recording.self, from: localData)
        XCTAssertEqual(restored.meeting?.ownerUserID, owner)

        let remoteData = try ReelJSON.encoder.encode(RemoteMeta(recording: recording, status: "ready", ownerName: "Owner", app: "Reel"))
        let remoteObject = try XCTUnwrap(JSONSerialization.jsonObject(with: remoteData) as? [String: Any])
        XCTAssertNil(remoteObject["ownerUserID"])
        XCTAssertFalse(String(decoding: remoteData, as: UTF8.self).contains(owner))
    }
}
