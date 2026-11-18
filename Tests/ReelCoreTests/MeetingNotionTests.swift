import Foundation
import XCTest
@testable import ReelCore

final class MeetingNotionTests: XCTestCase {
    func testRoutingIsConservativeAndHonorsPrivateMarkers() {
        let config = NotionRoutingConfiguration(defaultDataSourceID: "private", ownerEmail: "owner@ours.com", internalDomains: ["ours.com"],
            team: [.init(name: "Alex", emails: ["alex@ours.com"], privateDataSourceID: "alex-private")],
            clients: [.init(name: "Acme", domains: ["acme.com"], dataSourceID: "acme-db")])
        XCTAssertEqual(MeetingNotion.resolveRoute(title: "Weekly", attendees: ["OWNER@ours.com", "ceo@acme.com"], configuration: config).dataSourceID, "acme-db")
        XCTAssertEqual(MeetingNotion.resolveRoute(title: "1:1 planning", attendees: ["owner@ours.com", "ceo@acme.com"], configuration: config).kind, "private")
        XCTAssertEqual(MeetingNotion.resolveRoute(title: "Sync", attendees: ["owner@ours.com", "alex@ours.com"], configuration: config).dataSourceID, "alex-private")
        XCTAssertEqual(MeetingNotion.resolveRoute(title: "Sync", attendees: ["owner@ours.com", "a@acme.com", "b@unknown.org"], configuration: config).kind, "private")
        XCTAssertEqual(MeetingNotion.resolveRoute(title: "Sync", attendees: ["guest@acme.com"], configuration: config).kind, "private")
    }

    func testConfigurationUsesRecorderSnakeCaseKeys() throws {
        let data = Data(#"{"default_data_source_id":"d","owner_email":"o@x.com","internal_domains":["x.com"],"team":[{"name":"A","emails":["a@x.com"],"private_data_source_id":"p"}],"clients":[{"name":"C","domains":["c.com"],"data_source_id":"c"}]}"#.utf8)
        let config = try JSONDecoder().decode(NotionRoutingConfiguration.self, from: data)
        XCTAssertEqual(config.defaultDataSourceID, "d")
        XCTAssertEqual(config.team.first?.privateDataSourceID, "p")
        XCTAssertEqual(config.clients.first?.dataSourceID, "c")
    }

    func testMissingRoutingKeysAndAttendeeEdgeCasesStayPrivate() throws {
        let minimal = try JSONDecoder().decode(NotionRoutingConfiguration.self, from: Data(#"{"default_data_source_id":"private"}"#.utf8))
        XCTAssertEqual(minimal.ownerEmail, "")
        XCTAssertTrue(minimal.team.isEmpty)
        XCTAssertTrue(minimal.clients.isEmpty)

        let config = NotionRoutingConfiguration(defaultDataSourceID: "private", ownerEmail: "owner@ours.com", internalDomains: ["ours.com"],
            clients: [.init(name: "Acme", domains: ["acme.com"], dataSourceID: "acme-db")])
        XCTAssertEqual(MeetingNotion.resolveRoute(title: "Sync", attendees: ["owner@ours.com", "guest@ours.com"], configuration: config).kind, "private")
        XCTAssertEqual(MeetingNotion.resolveRoute(title: "Sync", attendees: ["owner@ours.com", "guest@acme.com", "guest@gmail.com"], configuration: config).dataSourceID, "acme-db")
        XCTAssertEqual(MeetingNotion.resolveRoute(title: "Sync", attendees: ["owner@ours.com", "broken@@acme.com"], configuration: config).kind, "private")
    }

    func testDocumentIdentityBlocksAndReadback() throws {
        let input = MeetingNotion.Input(id: "abc-123", title: "Planning", callDate: "2026-10-29", summary: "Decision", segments: [.init(start: 1.25, speaker: "Sam", text: "Hello")])
        let blocks = try MeetingNotion.blocks(for: input)
        XCTAssertEqual(MeetingNotion.identity(for: input), "reel_abc-123")
        let request = try JSONSerialization.jsonObject(with: MeetingNotion.createRequestData(for: input, parentDataSourceID: "db")) as! [String: Any]
        let props = request["properties"] as! [String: Any]
        XCTAssertEqual((((props["Name"] as! [String: Any])["title"] as! [[String: Any]]).first?["text"] as? [String: Any])?["content"] as? String, "Planning")
        XCTAssertEqual((((props["Meeting ID"] as! [String: Any])["rich_text"] as! [[String: Any]]).first?["text"] as? [String: Any])?["content"] as? String, "reel_abc-123")
        let page: [String: Any] = ["parent":["data_source_id":"db"], "properties":["Name":["title":[["plain_text":"Planning"]]], "Meeting ID":["rich_text":[["plain_text":"reel_abc-123"]]]], "children":blocks]
        XCTAssertTrue(MeetingNotion.readbackMatches(page: page, expectedParentID: "db", input: input, expectedBlocks: blocks))
        var wrong = page; wrong["parent"] = ["data_source_id":"other"]
        XCTAssertFalse(MeetingNotion.readbackMatches(page: wrong, expectedParentID: "db", input: input, expectedBlocks: blocks))
    }

    func testOversizeTranscriptRejectedBeforeCreate() {
        let huge = String(repeating: "x", count: 95_001)
        let input = MeetingNotion.Input(id: "large", title: "Large", callDate: "2026-10-29", summary: "", segments: [.init(start: 0, speaker: "A", text: huge)])
        XCTAssertThrowsError(try MeetingNotion.createRequest(for: input, parentDataSourceID: "db")) { XCTAssertEqual($0 as? MeetingNotion.BuildError, .tooLarge) }
    }
}
