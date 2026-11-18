import Foundation
import ReelCore

/// Uses the shared server routing and provider receipts; no Notion or mail credential lives here.
@MainActor
enum MeetingDeliveryService {
    private static let base = CloudConfig.default.deliveryServiceURL
    private struct Envelope: Codable {
        let id: String; let title: String; let started_at: String; let attendees: [String]
        let summary: String; let segments: [TranscriptSegment]; let calendar: MeetingCalendarReference?
        enum CodingKeys: String, CodingKey { case id, title, started_at, attendees, summary, segments, calendar }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id); try c.encode(title, forKey: .title); try c.encode(started_at, forKey: .started_at)
            try c.encode(attendees, forKey: .attendees); try c.encode(summary, forKey: .summary)
            try c.encode(segments, forKey: .segments); try c.encode(calendar, forKey: .calendar)
        }
    }
    private struct Response: Decodable {
        let verified: Bool; let email_status: String
    }
    /// Review the source in the immutable outbound body, not a newer local transcript.
    static func reviewSavedEnvelope(_ recording: Recording) async throws -> Data {
        guard var meeting = recording.meeting, let body = meeting.deliveryEnvelope else { throw CancellationError() }
        let saved = try JSONDecoder().decode(Envelope.self, from: body)
        guard saved.id == recording.id, !saved.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !saved.segments.isEmpty, saved.segments.allSatisfy({ $0.start.isFinite && $0.end.isFinite && $0.start >= 0 && $0.end >= $0.start }) else {
            throw MeetingSummaryReviewError.required
        }
        meeting.attendees = saved.attendees
        let transcript = Transcript(id: recording.shareID, title: saved.title, language: "en", engine: "OpenAI gpt-transcribe",
                                    createdAt: recording.createdAt, durationSeconds: recording.durationSeconds, segments: saved.segments)
        _ = try await CloudMeetingSpeech.summarize(transcript: transcript, meeting: meeting, title: saved.title)
        return body
    }
    static func envelope(_ recording: Recording, transcript: Transcript) throws -> Data {
        if recording.meeting?.needsContentReview == true { throw MeetingSummaryReviewError.required }
        guard recording.meeting?.permitsReviewedDelivery == true else {
            throw CloudError.message("Finish the meeting summary review before delivering notes.")
        }
        if let saved = recording.meeting?.deliveryEnvelope { return saved }
        guard let meeting = recording.meeting, meeting.ownerUserID != nil,
              recording.summaryEngine == "OpenAI gpt-6.1-sol", let summary = recording.summary, !summary.isEmpty else {
            throw CloudError.message("Finish the AI meeting notes before delivering them.")
        }
        var calendar = meeting.calendar
        if calendar == nil, let occurrence = meeting.calendarOccurrenceID {
            let prefix = "10:reel-cloud64:"
            let parts = occurrence.hasPrefix(prefix) ? occurrence.dropFirst(prefix.count).split(separator: ":") : []
            guard parts.count == 2, parts[0].count == 64, parts[0].allSatisfy({ $0.isHexDigit }),
                  let seconds = Double(parts[1]), seconds.isFinite else {
                throw CloudError.message("The original calendar invitation could not be identified. Notes have not been sent.")
            }
            calendar = MeetingCalendarReference(legacyOccurrenceID: String(parts[0]),
                occurrenceStart: ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: seconds)))
        }
        return try JSONEncoder().encode(Envelope(id: recording.id, title: recording.title,
            started_at: ISO8601DateFormatter().string(from: recording.createdAt), attendees: meeting.attendees,
            summary: summary, segments: transcript.segments, calendar: calendar))
    }
    static func deliver(_ recording: Recording, transcript: Transcript, stillCurrent: @MainActor @escaping () -> Bool) async throws -> MeetingDeliveryReceipt {
        guard let owner = recording.meeting?.ownerUserID else { throw CancellationError() }
        let body = try envelope(recording, transcript: transcript)
        let data = try await request(path: "delivery/complete", method: "POST", body: body, owner: owner, stillCurrent: stillCurrent)
        let response = try JSONDecoder().decode(Response.self, from: data)
        let receipt = try JSONDecoder().decode(MeetingDeliveryReceipt.self, from: data)
        guard response.verified, response.email_status == "confirmed", !receipt.pageID.isEmpty,
              let url = URL(string: receipt.url), url.scheme == "https",
              ["www.notion.so", "notion.so", "app.notion.com"].contains(url.host ?? ""),
              receipt.recipients.allSatisfy(CloudConfig.default.permits(email:)) else { throw CloudError.message("Meeting delivery did not return a verified receipt.") }
        return receipt
    }

    private static func request(path: String, method: String, body: Data?, owner: String, stillCurrent: @MainActor @escaping () -> Bool) async throws -> Data {
        try Task.checkCancellation()
        guard stillCurrent(), await CloudAuth.shared.current?.userID == owner else { throw CancellationError() }
        let auth = try await CloudAuth.shared.validSession()
        guard stillCurrent(), auth.userID == owner, await CloudAuth.shared.current?.userID == owner else { throw CancellationError() }
        try Task.checkCancellation()
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = method; request.httpBody = body; request.timeoutInterval = method == "GET" ? 15 : 180
        request.setValue("Bearer \(auth.idToken)", forHTTPHeaderField: "Authorization")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForResource = 180
        let session = URLSession(configuration: configuration, delegate: DeliveryRedirectBlocker(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard stillCurrent(), await CloudAuth.shared.current?.userID == owner else { throw CancellationError() }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw CloudError.message("Delivery could not be confirmed. Reel will retry and reconcile the existing page and email.")
        }
        return data
    }
}

private final class DeliveryRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
