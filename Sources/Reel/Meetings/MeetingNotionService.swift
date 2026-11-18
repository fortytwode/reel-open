import Foundation
import CryptoKit
import Security
import SwiftUI
import ReelCore

/// User initiated Notion delivery. Meeting content remains local unless a destination is configured.
@MainActor
final class MeetingNotionService: ObservableObject {
    static let shared = MeetingNotionService()
    private let session: URLSession
    private static let routingURL = SettingsStore.directory.appendingPathComponent("notion-routing.json")
    private let tokenProvider: () -> String?
    private var inFlight = Set<String>()
    private var configuration: NotionRoutingConfiguration?
    @Published private(set) var configured: Bool

    private init() {
        let c = URLSessionConfiguration.ephemeral
        c.httpShouldSetCookies = false
        session = URLSession(configuration: c, delegate: NoRedirectDelegate(), delegateQueue: nil)
        configuration = Self.loadRouting()
        tokenProvider = { Self.loadToken() }
        configured = Self.loadToken() != nil && configuration.map(Self.validRouting) == true
    }

    /// Internal transport injection for deterministic protocol-level smoke tests.
    init(session: URLSession, routingConfiguration: NotionRoutingConfiguration, tokenProvider: @escaping () -> String?) {
        self.session = session
        self.configuration = routingConfiguration
        self.tokenProvider = tokenProvider
        self.configured = tokenProvider() != nil && Self.validRouting(routingConfiguration)
    }

    func saveConfiguration(token: String, routingJSON: String) throws {
        guard let data = routingJSON.data(using: .utf8), let config = try? JSONDecoder().decode(NotionRoutingConfiguration.self, from: data),
              let object = try? JSONSerialization.jsonObject(with: data), JSONSerialization.isValidJSONObject(object) else {
            throw DeliveryError.invalidConfiguration
        }
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.validRouting(config), (!trimmed.isEmpty || Self.loadToken() != nil) else { throw DeliveryError.invalidConfiguration }
        try FileManager.default.createDirectory(at: Self.routingURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: Self.routingURL, options: .atomic)
        if !trimmed.isEmpty { try Self.saveToken(trimmed) }
        configuration = config
        configured = true
    }

    func route(for recording: Recording) -> NotionRoute {
        guard let configuration, let meeting = recording.meeting else {
            return NotionRoute(kind: "private", name: "Private calls", dataSourceID: nil, reason: "Not configured or not a meeting")
        }
        return MeetingNotion.resolveRoute(title: recording.title, attendees: meeting.attendees, configuration: configuration)
    }

    func deliveryStatus(for recording: Recording, library: LibraryStore = LibraryStore(root: LibraryStore.defaultRoot)) -> String {
        let state: DeliveryState?
        do { state = try readState(recording, library: library) }
        catch { return "Delivery state unreadable" }
        if state?.receipt != nil { return "Delivered (verify before retry)" }
        if state?.attempt != nil { return "Delivery needs reconciliation" }
        return "Not delivered"
    }

    func deliver(_ recording: Recording, library: LibraryStore) async throws -> URL {
        guard recording.isMeeting, configured, let token = tokenProvider(), let route = configuration.map({ MeetingNotion.resolveRoute(title: recording.title, attendees: recording.meeting?.attendees ?? [], configuration: $0) }),
              let parentID = route.dataSourceID, Self.validID(parentID) else { throw DeliveryError.notConfigured }
        guard inFlight.insert(recording.id).inserted else { throw DeliveryError.inProgress }
        defer { inFlight.remove(recording.id) }
        let input = try makeInput(recording, library: library)
        let blocks = try MeetingNotion.blocks(for: input)
        let body = try MeetingNotion.createRequestData(for: input, parentDataSourceID: parentID)
        guard body.count <= 500 * 1024 else { throw DeliveryError.tooLarge }
        let identity = MeetingNotion.identity(for: input)
        let digest = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        let folder = library.folder(for: recording)
        let stateURL = folder.appendingPathComponent("notion-delivery.json")
        var state = try readState(recording, library: library) ?? DeliveryState()
        if let attempt = state.attempt, attempt.parentID != parentID || attempt.identity != identity || attempt.contentHash != digest {
            throw DeliveryError.attemptChanged
        }
        if let receipt = state.receipt, receipt.parentID != parentID || receipt.identity != identity || receipt.contentHash != digest {
            throw DeliveryError.attemptChanged
        }
        let hasReceipt = state.receipt != nil

        try await validateSchema(token: token, parentID: parentID)

        // Always reconcile first. Once a create may have been sent, never issue another create
        // unless a definitive client response proved that request was rejected.
        if let pageURL = try await findExactPage(token: token, parentID: parentID, input: input, expectedBlocks: blocks) {
            state.receipt = Receipt(identity: identity, parentID: parentID, contentHash: digest, url: pageURL.absoluteString)
            state.attempt = nil
            try write(state, to: stateURL)
            return pageURL
        }
        if hasReceipt { throw DeliveryError.ambiguous }
        if state.attempt != nil { throw DeliveryError.ambiguous }

        state.attempt = Attempt(parentID: parentID, identity: identity, contentHash: digest)
        state.receipt = nil
        try write(state, to: stateURL) // Durable before sending a create request.
        do {
            let response = try await request(path: "pages", method: "POST", token: token, body: body)
            if [400,401,403,404,422,429].contains(response.status) {
                state.attempt = nil
                try write(state, to: stateURL)
                throw DeliveryError.rejected
            }
            guard (200..<300).contains(response.status), let page = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                  let pageID = page["id"] as? String else { throw DeliveryError.ambiguous }
            let verified = try await readPage(token: token, id: pageID, parentID: parentID, input: input, expectedBlocks: blocks)
            state.receipt = Receipt(identity: identity, parentID: parentID, contentHash: digest, url: verified.absoluteString)
            state.attempt = nil
            try write(state, to: stateURL)
            return verified
        } catch let e as DeliveryError { throw e }
        catch { throw DeliveryError.ambiguous }
    }

    private func makeInput(_ r: Recording, library: LibraryStore) throws -> MeetingNotion.Input {
        let transcriptData = try Data(contentsOf: library.transcriptJSONURL(for: r))
        let transcript = try ReelJSON.decoder.decode(Transcript.self, from: transcriptData)
        return MeetingNotion.Input(id: r.id, title: r.title, callDate: ISO8601DateFormatter().string(from: r.createdAt),
                                   summaryMethod: r.summaryEngine ?? "imported", summary: r.summary ?? "",
                                   actionItems: [], segments: transcript.segments.map { .init(start: $0.start, speaker: "", text: $0.text) })
    }

    private func findExactPage(token: String, parentID: String, input: MeetingNotion.Input, expectedBlocks: [[String: Any]]) async throws -> URL? {
        let filter: [String: Any] = ["property":"Meeting ID", "rich_text":["equals":MeetingNotion.identity(for: input)]]
        let body = try JSONSerialization.data(withJSONObject: ["filter":filter, "page_size":100])
        let response = try await request(path: "data_sources/\(parentID)/query", method: "POST", token: token, body: body)
        guard (200..<300).contains(response.status), let result = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
              let pages = result["results"] as? [[String: Any]], result["has_more"] as? Bool != true else { throw DeliveryError.ambiguous }
        guard pages.count <= 1 else { throw DeliveryError.duplicate }
        guard let page = pages.first else { return nil }
        guard let id = page["id"] as? String, Self.validID(id) else { throw DeliveryError.ambiguous }
        return try await readPage(token: token, id: id, parentID: parentID, input: input, expectedBlocks: expectedBlocks)
    }

    private func readPage(token: String, id: String, parentID: String, input: MeetingNotion.Input, expectedBlocks: [[String: Any]]) async throws -> URL {
        guard Self.validID(id) else { throw DeliveryError.ambiguous }
        let response = try await request(path: "pages/\(id)", method: "GET", token: token)
        guard (200..<300).contains(response.status), let page = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
              page["url"] as? String != nil else { throw DeliveryError.ambiguous }
        var complete = page
        var allBlocks: [[String: Any]] = []
        var cursor: String? = nil
        var pagesRead = 0
        repeat {
            pagesRead += 1
            guard pagesRead <= 2 else { throw DeliveryError.mismatch }
            var components = URLComponents()
            components.path = "/v1/blocks/\(id)/children"
            components.queryItems = [URLQueryItem(name: "page_size", value: "100")]
            if let cursor { components.queryItems?.append(URLQueryItem(name: "start_cursor", value: cursor)) }
            components.scheme = "https"
            components.host = "api.notion.com"
            guard let childrenURL = components.url else { throw DeliveryError.ambiguous }
            let pageResponse = try await request(url: childrenURL, method: "GET", token: token)
            guard (200..<300).contains(pageResponse.status), let result = try? JSONSerialization.jsonObject(with: pageResponse.data) as? [String: Any],
                  let children = result["results"] as? [[String: Any]] else { throw DeliveryError.ambiguous }
            allBlocks += children
            guard allBlocks.count <= 100 else { throw DeliveryError.mismatch }
            if result["has_more"] as? Bool == true {
                guard let next = result["next_cursor"] as? String, !next.isEmpty else { throw DeliveryError.mismatch }
                cursor = next
            } else { cursor = nil }
        } while cursor != nil
        complete["children"] = allBlocks
        guard MeetingNotion.readbackMatches(page: complete, expectedParentID: parentID, input: input, expectedBlocks: expectedBlocks),
              let url = URL(string: complete["url"] as! String) else { throw DeliveryError.mismatch }
        return url
    }

    private func validateSchema(token: String, parentID: String) async throws {
        let response = try await request(path: "data_sources/\(parentID)", method: "GET", token: token)
        guard (200..<300).contains(response.status), let object = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
              let properties = object["properties"] as? [String: Any],
              (properties["Name"] as? [String: Any])?["type"] as? String == "title",
              (properties["Meeting ID"] as? [String: Any])?["type"] as? String == "rich_text",
              (properties["Call Date"] as? [String: Any])?["type"] as? String == "date" else { throw DeliveryError.invalidSchema }
    }

    private func request(path: String, method: String, token: String, body: Data? = nil) async throws -> (data: Data, status: Int) {
        guard let url = URL(string: "https://api.notion.com/v1/\(path)") else { throw DeliveryError.ambiguous }
        return try await request(url: url, method: method, token: token, body: body)
    }
    private func request(url: URL, method: String, token: String, body: Data? = nil) async throws -> (data: Data, status: Int) {
        var req = URLRequest(url: url); req.httpMethod = method; req.httpBody = body
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("2025-09-03", forHTTPHeaderField: "Notion-Version")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { throw DeliveryError.ambiguous }
            if [400,401,403,404,422,429].contains(http.statusCode) {
                // A definitive rejection permits a later user initiated retry.
                return (data, http.statusCode)
            }
            return (data, http.statusCode)
        } catch { throw DeliveryError.ambiguous }
    }

    private struct DeliveryState: Codable { var attempt: Attempt?; var receipt: Receipt? }
    private struct Attempt: Codable { var parentID: String; var identity: String; var contentHash: String }
    private struct Receipt: Codable { var identity: String; var parentID: String; var contentHash: String; var url: String }
    private func readState(_ r: Recording, library: LibraryStore) throws -> DeliveryState? {
        let url = library.folder(for: r).appendingPathComponent("notion-delivery.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do { return try JSONDecoder().decode(DeliveryState.self, from: Data(contentsOf: url)) }
        catch { throw DeliveryError.stateUnreadable }
    }
    private func write(_ state: DeliveryState, to url: URL) throws {
        try JSONEncoder().encode(state).write(to: url, options: .atomic)
    }

    private static func loadRouting() -> NotionRoutingConfiguration? {
        guard let data = try? Data(contentsOf: routingURL) else { return nil }
        return try? JSONDecoder().decode(NotionRoutingConfiguration.self, from: data)
    }
    private static func validID(_ value: String) -> Bool { UUID(uuidString: value) != nil }
    private static func validRouting(_ c: NotionRoutingConfiguration) -> Bool {
        guard let fallback = c.defaultDataSourceID, validID(fallback) else { return false }
        return c.team.allSatisfy { $0.privateDataSourceID.map(validID) ?? true }
            && c.clients.allSatisfy { $0.dataSourceID.map(validID) ?? true }
    }
    private static func loadToken() -> String? {
        let q: [String: Any] = [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:OrganizationState.current.notionService, kSecAttrAccount as String:"token", kSecReturnData as String:true, kSecMatchLimit as String:kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    private static func saveToken(_ token: String) throws {
        let q: [String: Any] = [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:OrganizationState.current.notionService, kSecAttrAccount as String:"token"]
        let data = Data(token.utf8)
        let status = SecItemUpdate(q as CFDictionary, [kSecValueData as String:data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = q; add[kSecValueData as String] = data; add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw DeliveryError.invalidConfiguration }
        } else if status != errSecSuccess { throw DeliveryError.invalidConfiguration }
    }
    enum DeliveryError: LocalizedError {
        case notConfigured, invalidConfiguration, inProgress, ambiguous, duplicate, mismatch, rejected, attemptChanged, stateUnreadable, invalidSchema, tooLarge
        var errorDescription: String? {
            switch self {
            case .notConfigured: "Notion delivery is not configured for this meeting."
            case .invalidConfiguration: "Notion settings could not be saved."
            case .inProgress: "This meeting is already being delivered."
            case .ambiguous: "Notion delivery could not be confirmed. Check the destination before retrying."
            case .duplicate: "More than one Notion page has this meeting identity."
            case .mismatch: "The Notion page did not match the meeting content."
            case .rejected: "Notion rejected the delivery request. Check the settings and retry."
            case .attemptChanged: "This meeting or its Notion destination changed after a delivery attempt. Review the prior attempt before sending again."
            case .stateUnreadable: "The saved Notion delivery state could not be read safely."
            case .invalidSchema: "The Notion destination is missing required meeting properties."
            case .tooLarge: "This meeting exceeds Notion's supported request size."
            }
        }
    }
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
