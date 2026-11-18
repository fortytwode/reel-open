import Foundation
import ReelCore
import Security

private final class MockProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    static var requests: [URLRequest] = []
    static func reset(_ callback: @escaping (URLRequest) throws -> (Int, Data)) { requests = []; handler = callback }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = Self.handler else { fatalError("mock handler missing") }
        Self.requests.append(request)
        do {
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type":"application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@MainActor @main struct MeetingNotionSmoke {
    static let sourceID = UUID().uuidString.lowercased()
    static let pageID = UUID().uuidString.lowercased()
    static let config = NotionRoutingConfiguration(defaultDataSourceID: sourceID, ownerEmail: "owner@acme.test", internalDomains: ["acme.test"])
    static let meeting = Recording(id: UUID().uuidString.lowercased(), title: "Smoke meeting", createdAt: Date(timeIntervalSince1970: 1_700_000_000), durationSeconds: 20, width: 10, height: 10, mode: .window, folderName: UUID().uuidString, meeting: MeetingDetails(attendees: ["owner@acme.test", "client@outside.test"]))
    static let root = FileManager.default.temporaryDirectory.appendingPathComponent("MeetingNotionSmoke-\(UUID().uuidString)", isDirectory: true)

    static func main() async throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = LibraryStore(root: root)
        try writeTranscript(for: meeting, library: library)
        try await successfulCreateAndIdempotentRetry(library)
        try await uncertainCreateStaysSingle(library)
        try await corruptStateFailsClosed(library)
        try await changedDestinationFailsClosed(library)
        print("MeetingNotion smoke passed: create/readback, repeat reconciliation, ambiguous 503, corrupt state, changed destination")
    }

    static func successfulCreateAndIdempotentRetry(_ library: LibraryStore) async throws {
        var created = false
        MockProtocol.reset { request in
            let path = request.url!.path
            if path.hasSuffix("/data_sources/\(sourceID)") && request.httpMethod == "GET" { return (200, try json(["properties":["Name":["type":"title"],"Meeting ID":["type":"rich_text"],"Call Date":["type":"date"]]])) }
            if path.hasSuffix("/query") { return (200, try json(["results": created ? [pageSummary()] : [], "has_more":false])) }
            if path == "/v1/pages" && request.httpMethod == "POST" { created = true; return (200, try json(["id":pageID])) }
            if path == "/v1/pages/\(pageID)" { return (200, try json(pageSummary())) }
            if path == "/v1/blocks/\(pageID)/children" { return (200, try json(["results":expectedChildren(),"has_more":false])) }
            throw SmokeFailure.unexpected(path)
        }
        let service = makeService()
        _ = try await service.deliver(meeting, library: library)
        _ = try await service.deliver(meeting, library: library)
        try check(MockProtocol.requests.filter { $0.url?.path == "/v1/pages" && $0.httpMethod == "POST" }.count == 1, "repeat delivery created a duplicate")
    }

    static func uncertainCreateStaysSingle(_ library: LibraryStore) async throws {
        let folder = recording(id: UUID().uuidString.lowercased())
        try writeTranscript(for: folder, library: library)
        var creates = 0
        MockProtocol.reset { request in
            let path = request.url!.path
            if path.hasSuffix("/data_sources/\(sourceID)") { return (200, try json(["properties":["Name":["type":"title"],"Meeting ID":["type":"rich_text"],"Call Date":["type":"date"]]])) }
            if path.hasSuffix("/query") { return (200, try json(["results":[],"has_more":false])) }
            if path == "/v1/pages" { creates += 1; return (503, Data("{}".utf8)) }
            throw SmokeFailure.unexpected(path)
        }
        do { _ = try await makeService().deliver(folder, library: library); throw SmokeFailure.assertion("503 unexpectedly succeeded") } catch is MeetingNotionService.DeliveryError { }
        do { _ = try await makeService().deliver(folder, library: library); throw SmokeFailure.assertion("uncertain attempt unexpectedly retried") } catch is MeetingNotionService.DeliveryError { }
        try check(creates == 1, "ambiguous 503 was blindly retried")
    }

    static func corruptStateFailsClosed(_ library: LibraryStore) async throws {
        let r = recording(id: UUID().uuidString.lowercased())
        try writeTranscript(for: r, library: library)
        try Data("not json".utf8).write(to: library.folder(for: r).appendingPathComponent("notion-delivery.json"))
        MockProtocol.reset { _ in throw SmokeFailure.assertion("corrupt state triggered network") }
        try check(makeService().deliveryStatus(for: r, library: library) == "Delivery state unreadable", "corrupt state was not reported")
        do { _ = try await makeService().deliver(r, library: library); throw SmokeFailure.assertion("corrupt state was accepted") }
        catch is MeetingNotionService.DeliveryError { }
        try check(MockProtocol.requests.isEmpty, "corrupt state reached network")
    }

    static func changedDestinationFailsClosed(_ library: LibraryStore) async throws {
        let r = recording(id: UUID().uuidString.lowercased())
        try writeTranscript(for: r, library: library)
        MockProtocol.reset { request in
            if request.url!.path.hasSuffix("/data_sources/\(sourceID)") { return (200, try json(["properties":["Name":["type":"title"],"Meeting ID":["type":"rich_text"],"Call Date":["type":"date"]]])) }
            if request.url!.path.hasSuffix("/query") { return (200, try json(["results":[],"has_more":false])) }
            if request.url!.path == "/v1/pages" { return (503, try json([:])) }
            throw SmokeFailure.unexpected(request.url!.path)
        }
        do { _ = try await makeService().deliver(r, library: library); throw SmokeFailure.assertion("503 unexpectedly succeeded") } catch is MeetingNotionService.DeliveryError { }
        let otherConfig = NotionRoutingConfiguration(defaultDataSourceID: UUID().uuidString.lowercased(), ownerEmail: "owner@acme.test")
        MockProtocol.reset { _ in throw SmokeFailure.assertion("changed destination triggered network") }
        do { _ = try await makeService(otherConfig).deliver(r, library: library); throw SmokeFailure.assertion("changed destination was accepted") } catch is MeetingNotionService.DeliveryError { }
    }

    static func makeService(_ routing: NotionRoutingConfiguration? = nil) -> MeetingNotionService {
        let c = URLSessionConfiguration.ephemeral; c.protocolClasses = [MockProtocol.self]
        return MeetingNotionService(session: URLSession(configuration: c), routingConfiguration: routing ?? config, tokenProvider: { "test-token" })
    }
    static func recording(id: String) -> Recording {
        var r = meeting; r.id = id; r.folderName = UUID().uuidString
        return r
    }
    static func writeTranscript(for r: Recording, library: LibraryStore) throws {
        _ = try library.ensureFolder(for: r)
        let transcript = Transcript(id: r.id, title: r.title, language: "en", engine: "smoke", createdAt: r.createdAt, durationSeconds: 20, segments: [TranscriptSegment(start: 0, end: 2, text: "Hello there.")])
        try transcript.encoded().write(to: library.transcriptJSONURL(for: r))
    }
    static func pageSummary() -> [String: Any] {
        ["id":pageID, "url":"https://www.notion.so/Smoke-\(pageID)", "archived":false, "in_trash":false,
         "parent":["data_source_id":sourceID], "properties":["Name":["title":[["plain_text":meeting.title]]], "Meeting ID":["rich_text":[["plain_text":"reel_\(meeting.id)"]]]]]
    }
    static func expectedChildren() -> [[String: Any]] {
        let input = MeetingNotion.Input(id: meeting.id, title: meeting.title, callDate: ISO8601DateFormatter().string(from: meeting.createdAt), summaryMethod: "imported", summary: "", actionItems: [], segments: [.init(start: 0, speaker: "", text: "Hello there.")])
        return (try! MeetingNotion.blocks(for: input)).map { block in
            let type = block["type"] as! String
            var copy = block
            var body = copy[type] as! [String: Any]
            let rich = body["rich_text"] as! [[String: Any]]
            body["rich_text"] = rich.map { part -> [String: Any] in
                let text = part["text"] as! [String: Any]
                return ["type":"text", "plain_text":text["content"] as! String]
            }
            copy[type] = body
            return copy
        }
    }
    static func json(_ object: Any) throws -> Data { try JSONSerialization.data(withJSONObject: object) }
    static func check(_ condition: Bool, _ message: String) throws { if !condition { throw SmokeFailure.assertion(message) } }
}

private enum SmokeFailure: Error { case assertion(String), unexpected(String) }
