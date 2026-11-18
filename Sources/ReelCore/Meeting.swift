import Foundation
import CryptoKit

public struct MeetingCalendarReference: Codable, Equatable, Sendable {
    public var calendarID: String?
    public var eventID: String?
    public var icalUID: String?
    public var legacyOccurrenceID: String?
    public var occurrenceStart: String
    public init(calendarID: String? = nil, eventID: String? = nil, icalUID: String? = nil, legacyOccurrenceID: String? = nil, occurrenceStart: String) {
        self.calendarID = calendarID; self.eventID = eventID; self.icalUID = icalUID; self.occurrenceStart = occurrenceStart
        self.legacyOccurrenceID = legacyOccurrenceID
    }
    enum CodingKeys: String, CodingKey {
        case calendarID = "calendar_id", eventID = "event_id", icalUID = "ical_uid", occurrenceStart = "occurrence_start"
        case legacyOccurrenceID = "legacy_occurrence_id"
    }
}

public struct MeetingDeliveryReceipt: Codable, Equatable, Sendable {
    public var pageID: String
    public var url: String
    public var recipients: [String]
    public var route: String
    public var suppressedDuplicate: Bool
    public init(pageID: String, url: String, recipients: [String], route: String, suppressedDuplicate: Bool) {
        self.pageID = pageID; self.url = url; self.recipients = recipients; self.route = route; self.suppressedDuplicate = suppressedDuplicate
    }
    enum CodingKeys: String, CodingKey {
        case pageID = "page_id", url, recipients, route, suppressedDuplicate = "suppressed_duplicate"
    }
}

/// Local meeting context. This is intentionally absent from public RemoteMeta.
public struct MeetingDetails: Codable, Equatable, Sendable {
    public var attendees: [String]
    public var calendarOccurrenceID: String?
    public var ownerUserID: String?
    public var calendar: MeetingCalendarReference?
    /// Absent on older recordings, so an update never bulk-emails the archive.
    public var deliveryStatus: DeliveryStatus?
    public var deliveryReceipt: MeetingDeliveryReceipt?
    public var deliveryError: String?
    public var deliveryRetryAt: Date?
    /// The summary service found meaningful meeting content. Missing on older notes.
    public var summaryReviewPassed: Bool?
    public var reviewedDeliveryEnvelopeHash: String?
    /// The first outbound body stays immutable so a retry can reconcile a lost response.
    public var deliveryEnvelope: Data?
    public enum DeliveryStatus: String, Codable, Sendable { case pending, failed, confirmed, noSpeech, reviewRequired }

    public var mayAutomaticallyProcess: Bool { !needsContentReview && (deliveryStatus == .pending || deliveryStatus == .failed) }
    public var needsContentReview: Bool { deliveryStatus == .reviewRequired || summaryReviewPassed == false }
    public var permitsReviewedDelivery: Bool {
        deliveryStatus != nil && !needsContentReview &&
            (summaryReviewPassed == true || (summaryReviewPassed == nil && deliveryReceipt != nil)) &&
            (deliveryEnvelope == nil || deliveryEnvelopePassedReview || deliveryReceipt != nil)
    }
    public var deliveryEnvelopePassedReview: Bool {
        guard let body = deliveryEnvelope else { return false }
        return reviewedDeliveryEnvelopeHash == Self.envelopeHash(body)
    }
    @discardableResult public mutating func recordEnvelopeReview(for body: Data) -> Bool {
        guard deliveryEnvelope == body else { return false }
        reviewedDeliveryEnvelopeHash = Self.envelopeHash(body)
        return true
    }
    private static func envelopeHash(_ body: Data) -> String {
        SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
    }

    public init(attendees: [String] = [], calendarOccurrenceID: String? = nil, ownerUserID: String? = nil) {
        self.attendees = attendees
        self.calendarOccurrenceID = calendarOccurrenceID
        self.ownerUserID = ownerUserID
    }

    public enum ValidationError: LocalizedError {
        case invalidAttendees
        case tooManyAttendees
        case invalidOccurrence

        public var errorDescription: String? {
            switch self {
            case .invalidAttendees: "Enter attendee email addresses separated by commas, or leave them blank."
            case .tooManyAttendees: "Use no more than 200 attendee email addresses."
            case .invalidOccurrence: "This calendar occurrence could not be identified. Choose the meeting again."
            }
        }
    }

    public static func parse(attendeeText: String, calendarOccurrenceID: String? = nil) throws -> MeetingDetails {
        let emails = attendeeText.split(whereSeparator: { $0 == "," || $0 == ";" || $0 == "\n" })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
        guard emails.count <= 200 else { throw ValidationError.tooManyAttendees }
        let pattern = #"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"#
        guard emails.allSatisfy({ $0.count <= 254 && $0.range(of: pattern, options: .regularExpression) != nil }) else {
            throw ValidationError.invalidAttendees
        }
        let occurrence = calendarOccurrenceID?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let occurrence, occurrence.count > 500 || occurrence.contains(where: { $0.isNewline || $0.isASCII && $0.asciiValue! < 32 }) {
            throw ValidationError.invalidOccurrence
        }
        return MeetingDetails(attendees: Array(Set(emails)).sorted(),
                              calendarOccurrenceID: occurrence?.isEmpty == false ? occurrence : nil)
    }

    public static func defaultTitle(for date: Date) -> String {
        let normal = Recording.defaultTitle(for: date)
        return "Meeting" + normal.dropFirst("Recording".count)
    }
}

public enum MeetingSummaryReviewError: LocalizedError {
    case required
    public var errorDescription: String? {
        "The transcript needs review before new notes can be sent. Your recording and transcript are saved."
    }
}

/// Meeting choices are a value snapshot, leaving the user's normal screen-recording choices alone.
public enum MeetingCapturePolicy {
    /// Calendar selection belongs to one capture attempt, including failed/cancelled attempts.
    public static func takeMeeting(attendeeText: String, ownerUserID: String?, occurrenceID: inout String?,
                                   calendar: inout MeetingCalendarReference?) throws -> MeetingDetails {
        let selectedID = occurrenceID, selectedCalendar = calendar
        occurrenceID = nil; calendar = nil
        var meeting = try MeetingDetails.parse(attendeeText: attendeeText, calendarOccurrenceID: selectedID)
        meeting.ownerUserID = ownerUserID; meeting.calendar = selectedCalendar; meeting.deliveryStatus = .pending
        return meeting
    }
    public static func settings(from normal: ReelSettings) -> ReelSettings {
        var meeting = normal
        meeting.mode = .window
        meeting.cameraEnabled = false
        meeting.audio = .micAndSystem
        meeting.fps = 15
        meeting.autoUpload = false
        meeting.liveUpload = false
        meeting.copyLinkOnStop = false
        meeting.aiSummary = true
        return meeting
    }

    public static func existingOccurrence(in recordings: [Recording], id: String?) -> Recording? {
        guard let id, !id.isEmpty else { return nil }
        return recordings.first { $0.meeting?.calendarOccurrenceID == id }
    }

    /// Revocation may stop only the automatic capture for this owner and occurrence.
    public static func shouldStopOnRevocation(automatic: Bool, authorizationValid: Bool,
                                              recording: Recording?, occurrenceID: String,
                                              ownerUserID: String?) -> Bool {
        guard automatic, !authorizationValid, !occurrenceID.isEmpty,
              let meeting = recording?.meeting else { return false }
        return meeting.calendarOccurrenceID == occurrenceID && meeting.ownerUserID == ownerUserID
    }
}
