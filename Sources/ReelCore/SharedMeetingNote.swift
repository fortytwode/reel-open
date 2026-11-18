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

    private enum CodingKeys: String, CodingKey {
        case id, title, attendees, recipients, summary
        case startedAt = "started_at", durationSeconds = "duration_seconds"
        case transcriptStatus = "transcript_status", localRecordingIDs = "local_recording_ids"
        case transcriptText = "transcript_text"
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
