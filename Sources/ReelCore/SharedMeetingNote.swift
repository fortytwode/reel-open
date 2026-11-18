import Foundation

public struct SharedMeetingNote: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let startedAt: Date
    public let durationSeconds: Double
    public let attendees: [String]
    public let recipients: [String]
    public let summary: String
    public let transcriptStatus: String
    public let localRecordingIDs: [String]
    public let transcriptText: String?
    public let transcriptSegments: [SharedMeetingTranscriptSegment]
    public let transcriptAttribution: SharedMeetingTranscriptAttribution?

    private enum CodingKeys: String, CodingKey {
        case id, title, attendees, recipients, summary
        case startedAt = "started_at", durationSeconds = "duration_seconds"
        case transcriptStatus = "transcript_status", localRecordingIDs = "local_recording_ids"
        case transcriptText = "transcript_text", segments
    }

    public static func isValidRemoteID(_ id: String) -> Bool {
        id.utf8.count == 69 && id.hasPrefix("reel_") && id.utf8.dropFirst(5).allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        guard Self.isValidRemoteID(id) else {
            throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "Invalid meeting ID")
        }
        title = try c.decode(String.self, forKey: .title)
        let timestamp = try c.decode(String.self, forKey: .startedAt)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fractional = formatter.date(from: timestamp)
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = fractional ?? formatter.date(from: timestamp) else {
            throw DecodingError.dataCorruptedError(forKey: .startedAt, in: c, debugDescription: "Invalid meeting date")
        }
        startedAt = date
        durationSeconds = try c.decode(Double.self, forKey: .durationSeconds)
        attendees = try c.decode([String].self, forKey: .attendees)
        recipients = try c.decode([String].self, forKey: .recipients)
        summary = try c.decode(String.self, forKey: .summary)
        transcriptStatus = try c.decode(String.self, forKey: .transcriptStatus)
        localRecordingIDs = try c.decode([String].self, forKey: .localRecordingIDs)
        transcriptText = try c.decodeIfPresent(String.self, forKey: .transcriptText)
        // Incomplete structured text would hide speech. Keep the complete plain-text
        // representation available when a segment cannot be decoded.
        let segments = (try? c.decode([SharedMeetingTranscriptSegment].self, forKey: .segments)) ?? []
        transcriptAttribution = segments.first?.speakerAttribution
        transcriptSegments = transcriptAttribution == .unavailable
            ? segments.map { $0.withoutSpeakerName() }
            : segments
    }
}

public enum SharedMeetingTranscriptAttribution: String, Equatable, Sendable {
    case unavailable, partial
    case platformCaptions = "platform_captions"

    public var notice: String {
        switch self {
        case .unavailable:
            "Speaker identification unavailable for this recording."
        case .partial:
            "Speaker identification is partial. Names are platform display labels. Timings are approximate."
        case .platformCaptions:
            "Speaker identification uses platform captions. Names are platform display labels. Timings are approximate."
        }
    }
}

public struct SharedMeetingTranscriptSegment: Decodable, Equatable, Sendable {
    public let text: String
    public let speakerName: String?
    public let start: Double?
    fileprivate let speakerAttribution: SharedMeetingTranscriptAttribution?

    public var approximateTimestamp: String? { start.map(Transcript.timestamp) }

    private enum CodingKeys: String, CodingKey {
        case text, start
        case speakerName = "speaker_name", speakerSource = "speaker_source", speakerMatch = "speaker_match"
        case speakerAttribution = "speaker_attribution", speakerCoverage = "speaker_coverage"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        let seconds = try? c.decode(Double.self, forKey: .start)
        start = seconds.flatMap { $0.isFinite && $0 >= 0 && $0 < Double(Int.max) ? $0 : nil }
        let coverage = try? c.decode(Double.self, forKey: .speakerCoverage)
        speakerAttribution = coverage.map { (0...1).contains($0) } == true
            ? (try? c.decode(String.self, forKey: .speakerAttribution)).flatMap(SharedMeetingTranscriptAttribution.init(rawValue:))
            : nil

        // Match the delivery service's rules for publishing speaker labels.
        let source = try? c.decode(String.self, forKey: .speakerSource)
        let match = try? c.decode(String.self, forKey: .speakerMatch)
        if let source, ["google_meet_caption", "teams_caption"].contains(source),
           match == "caption_text_match", let name = try? c.decode(String.self, forKey: .speakerName),
           name.unicodeScalars.count <= 120,
           !name.unicodeScalars.contains(where: {
               [.control, .format, .lineSeparator, .paragraphSeparator].contains($0.properties.generalCategory)
           }) {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            speakerName = trimmed.isEmpty ? nil : trimmed
        } else {
            speakerName = nil
        }
    }

    fileprivate func withoutSpeakerName() -> Self {
        Self(text: text, start: start, speakerAttribution: speakerAttribution)
    }

    private init(text: String, start: Double?, speakerAttribution: SharedMeetingTranscriptAttribution?) {
        self.text = text
        self.start = start
        self.speakerAttribution = speakerAttribution
        self.speakerName = nil
    }
}

public enum MeetingWorkspaceHistory {
    public static func localRecordings(_ recordings: [Recording], ownerUserID: String?, shared: [SharedMeetingNote]) -> [Recording] {
        guard let ownerUserID, !ownerUserID.isEmpty else { return [] }
        let sharedIDs = Set(shared.flatMap(\.localRecordingIDs).map(recordingKey))
        return recordings.filter { $0.meeting?.ownerUserID == ownerUserID && !sharedIDs.contains(recordingKey($0.id)) }
    }

    private static func recordingKey(_ id: String) -> String { UUID(uuidString: id)?.uuidString ?? id }
}
