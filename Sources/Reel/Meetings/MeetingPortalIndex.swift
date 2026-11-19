import Foundation
import ReelCore

/// Publishes only a meeting's library metadata to the private meeting portal.
@MainActor
enum MeetingPortalIndex {
    private static let endpoint = CloudConfig.default.meetingServiceURL.appendingPathComponent("meetings")
    private static var operationTails: [String: Task<Bool, Never>] = [:]
    private static var operationIDs: [String: UUID] = [:]
    private static var removedIDs = Set<String>()

    @discardableResult
    static func publish(_ recording: Recording) async -> Bool {
        let id = recording.id
        guard !removedIDs.contains(id) else { return false }
        let previous = operationTails[id]
        let token = UUID()
        let task = Task { @MainActor in
            _ = await previous?.value
            guard !removedIDs.contains(id), recording.isMeeting,
                  let latest = AppModel.shared.recording(id: id), latest.isMeeting,
                  latest.meeting?.ownerUserID != nil,
                  UUID(uuidString: latest.id) != nil,
                  await CloudAuth.shared.current != nil else { return false }
            return await sendPublish(latest)
        }
        operationTails[id] = task
        operationIDs[id] = token
        let result = await task.value
        clearOperation(id, token: token)
        return result
    }

    @discardableResult
    static func remove(_ recording: Recording) async -> Bool {
        let id = recording.id
        removedIDs.insert(id)
        let previous = operationTails[id]
        let token = UUID()
        let task = Task { @MainActor in
            _ = await previous?.value
            return await sendRemove(recording)
        }
        operationTails[id] = task
        operationIDs[id] = token
        let result = await task.value
        clearOperation(id, token: token)
        return result
    }

    private static func sendPublish(_ latest: Recording) async -> Bool {
        do {
            let session = try await CloudAuth.shared.validSession()
            guard !removedIDs.contains(latest.id),
                  let current = AppModel.shared.recording(id: latest.id), current.isMeeting,
                  current.meeting?.ownerUserID == session.userID,
                  !current.hasPublishableShareID || current.matchesPublisher(session.userID) else { return false }
            var payload: [String: Any] = [
                "id": current.id,
                "title": current.title,
                "started_at": ISO8601DateFormatter().string(from: current.createdAt),
                "duration_seconds": current.durationSeconds,
                "transcript_status": current.transcriptStatus.rawValue,
                "recording_source": "mac",
            ]
            if current.hasPublishableShareID, ShareLinks.isValidShareID(current.shareID) {
                payload["share_id"] = current.shareID.lowercased()
            }
            return await send(payload: payload, method: "POST", id: latest.id, token: session.idToken,
                              successMessage: "Meeting portal metadata synced")
        } catch {
            // Avoid logging request data, titles, tokens, or server response details.
            Log.cloud.info("Meeting portal metadata sync failed")
            return false
        }
    }

    private static func sendRemove(_ recording: Recording) async -> Bool {
        guard recording.isMeeting, UUID(uuidString: recording.id) != nil,
              let owner = recording.meeting?.ownerUserID else { return false }
        do {
            let session = try await CloudAuth.shared.validSession()
            guard owner == session.userID else { return false }
            return await send(payload: nil, method: "DELETE", id: recording.id, token: session.idToken,
                              successMessage: "Meeting portal metadata removed")
        } catch {
            Log.cloud.info("Meeting portal metadata removal failed")
            return false
        }
    }

    private static func send(payload: [String: Any]?, method: String, id: String, token: String,
                             successMessage: String) async -> Bool {
        let url = method == "DELETE" ? endpoint.appendingPathComponent(id) : endpoint
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let payload {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
            guard request.httpBody != nil else {
                Log.cloud.info("Meeting portal metadata sync failed")
                return false
            }
        }
        do {
            let (_, response) = try await URLSession.shared.data(for: request, delegate: RedirectBlocker())
            guard let response = response as? HTTPURLResponse,
                  (200..<300).contains(response.statusCode) else {
                Log.cloud.info("Meeting portal metadata request failed")
                return false
            }
            Log.cloud.info("\(successMessage, privacy: .public)")
            return true
        } catch {
            // Avoid logging request data, titles, tokens, or server response details.
            Log.cloud.info("Meeting portal metadata request failed")
            return false
        }
    }

    private static func clearOperation(_ id: String, token: UUID) {
        guard operationIDs[id] == token else { return }
        operationIDs[id] = nil
        operationTails[id] = nil
    }
}

/// Prevents URLSession from forwarding the bearer token to a redirect destination.
private final class RedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
