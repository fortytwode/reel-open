import Foundation
import Combine
import ReelCore

@MainActor
final class ParticipantNotesLibrary: ObservableObject {
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    @Published private(set) var detailLoadingID: String?
    @Published private(set) var detailError: String?
    @Published private(set) var nextCursor: String?
    @Published private var storedMeetings: [SharedMeetingNote] = []
    @Published private var storedDetails: [String: SharedMeetingNote] = [:]

    private var owner: String?
    private var generation: UInt64?
    private var listRequest = UUID()
    private var detailRequest = UUID()
    private var accountObserver: AnyCancellable?
    private static let endpoint = CloudConfig.default.deliveryServiceURL.appendingPathComponent("delivery/meetings")
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    init() {
        accountObserver = AppModel.shared.$account.dropFirst().sink { [weak self] account in
            guard let self, account?.userID != self.owner || AppModel.shared.accountGeneration != self.generation else { return }
            self.reset()
        }
    }

    var meetings: [SharedMeetingNote] { isCurrent ? storedMeetings : [] }
    func detail(id: String) -> SharedMeetingNote? { isCurrent ? storedDetails[id] : nil }

    private var isCurrent: Bool {
        guard let owner, let generation else { return false }
        return AppModel.shared.account?.userID == owner && AppModel.shared.accountGeneration == generation
    }

    func reset() {
        listRequest = UUID(); detailRequest = UUID()
        owner = nil; generation = nil
        storedMeetings = []; storedDetails = [:]
        loading = false; error = nil; detailLoadingID = nil; detailError = nil; nextCursor = nil
    }

    func refresh() async {
        if !isCurrent { reset() }
        guard let uid = AppModel.shared.account?.userID, !uid.isEmpty else {
            error = "Sign in to view meeting notes."
            return
        }
        owner = uid; generation = AppModel.shared.accountGeneration
        let requestID = UUID(); listRequest = requestID
        loading = true; error = nil
        await fetchPage(cursor: nil, requestID: requestID, append: false)
    }

    func loadMore() async {
        guard isCurrent, !loading, let cursor = nextCursor else { return }
        let requestID = UUID(); listRequest = requestID
        loading = true; error = nil
        await fetchPage(cursor: cursor, requestID: requestID, append: true)
    }

    private func fetchPage(cursor: String?, requestID: UUID, append: Bool) async {
        guard let uid = owner, let generation else { return }
        defer { if listRequest == requestID && isCurrent { loading = false } }
        do {
            var components = URLComponents(url: Self.endpoint, resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "limit", value: "50")]
            if let cursor { components.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
            let data = try await get(components.url!, uid: uid, generation: generation)
            guard listRequest == requestID, isCurrent else { return }
            let page = try JSONDecoder().decode(Page.self, from: data)
            guard page.nextCursor == nil || (page.nextCursor!.utf8.count <= 9 && !page.nextCursor!.isEmpty && page.nextCursor!.utf8.allSatisfy({ (48...57).contains($0) })) else { throw ClientError.unavailable }
            var seen = Set<String>()
            storedMeetings = ((append ? storedMeetings : []) + page.meetings).filter { seen.insert($0.id).inserted }
            nextCursor = page.nextCursor
        } catch {
            guard listRequest == requestID, isCurrent, !(error is CancellationError) else { return }
            self.error = message(for: error)
        }
    }

    func loadDetail(id: String) async {
        guard isCurrent, let uid = owner, let generation else { return }
        guard SharedMeetingNote.isValidRemoteID(id) else { detailError = "This meeting could not be opened."; return }
        let requestID = UUID(); detailRequest = requestID
        storedDetails[id] = nil
        detailLoadingID = id; detailError = nil
        defer { if detailRequest == requestID && isCurrent { detailLoadingID = nil } }
        do {
            let data = try await get(Self.endpoint.appendingPathComponent(id), uid: uid, generation: generation)
            guard detailRequest == requestID, isCurrent else { return }
            let result = try JSONDecoder().decode(Detail.self, from: data)
            guard result.meeting.id == id else { throw ClientError.unavailable }
            storedDetails[id] = result.meeting
        } catch {
            guard detailRequest == requestID, isCurrent, !(error is CancellationError) else { return }
            detailError = message(for: error)
        }
    }

    private func get(_ url: URL, uid: String, generation: UInt64) async throws -> Data {
        guard matches(uid, generation) else { throw CancellationError() }
        let auth: CloudSession
        do { auth = try await CloudAuth.shared.validSession() }
        catch { throw ClientError.signIn }
        guard matches(uid, generation), auth.userID == uid, !Task.isCancelled else { throw CancellationError() }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.setValue("Bearer \(auth.idToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request, delegate: NotesRedirectBlocker())
        guard matches(uid, generation), !Task.isCancelled else { throw CancellationError() }
        guard let http = response as? HTTPURLResponse else { throw ClientError.unavailable }
        if http.statusCode == 401 { throw ClientError.signIn }
        guard (200..<300).contains(http.statusCode) else { throw ClientError.unavailable }
        return data
    }

    private func matches(_ uid: String, _ generation: UInt64) -> Bool {
        isCurrent && owner == uid && self.generation == generation
    }
    private func message(for error: Error) -> String {
        if case ClientError.signIn = error { return "Please sign in again to view meeting notes." }
        return "Meeting notes are unavailable. Please try again."
    }
    private enum ClientError: Error { case signIn, unavailable }
    private struct Page: Decodable {
        let meetings: [SharedMeetingNote]
        let nextCursor: String?
        enum CodingKeys: String, CodingKey { case meetings; case nextCursor = "next_cursor" }
    }
    private struct Detail: Decodable { let meeting: SharedMeetingNote }
}

private final class NotesRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
