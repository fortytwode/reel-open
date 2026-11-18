import Foundation

/// Explicit routing configuration. JSON keys match recorder/routing.py.
public struct NotionRoutingConfiguration: Codable, Sendable {
    public struct Team: Codable, Sendable {
        public var name: String
        public var emails: [String]
        public var privateDataSourceID: String?
        public enum CodingKeys: String, CodingKey { case name, emails; case privateDataSourceID = "private_data_source_id" }
        public init(name: String, emails: [String], privateDataSourceID: String? = nil) { self.name = name; self.emails = emails; self.privateDataSourceID = privateDataSourceID }
    }
    public struct Client: Codable, Sendable {
        public var name: String
        public var domains: [String]
        public var dataSourceID: String?
        public enum CodingKeys: String, CodingKey { case name, domains; case dataSourceID = "data_source_id" }
        public init(name: String, domains: [String], dataSourceID: String? = nil) { self.name = name; self.domains = domains; self.dataSourceID = dataSourceID }
    }
    public var defaultDataSourceID: String?
    public var ownerEmail: String
    public var internalDomains: [String]
    public var team: [Team]
    public var clients: [Client]
    public enum CodingKeys: String, CodingKey {
        case team, clients
        case defaultDataSourceID = "default_data_source_id"
        case ownerEmail = "owner_email"
        case internalDomains = "internal_domains"
    }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        defaultDataSourceID = try values.decodeIfPresent(String.self, forKey: .defaultDataSourceID)
        ownerEmail = try values.decodeIfPresent(String.self, forKey: .ownerEmail) ?? ""
        internalDomains = try values.decodeIfPresent([String].self, forKey: .internalDomains) ?? []
        team = try values.decodeIfPresent([Team].self, forKey: .team) ?? []
        clients = try values.decodeIfPresent([Client].self, forKey: .clients) ?? []
    }
    public init(defaultDataSourceID: String? = nil, ownerEmail: String = "", internalDomains: [String] = [], team: [Team] = [], clients: [Client] = []) {
        self.defaultDataSourceID = defaultDataSourceID; self.ownerEmail = ownerEmail; self.internalDomains = internalDomains; self.team = team; self.clients = clients
    }
}

public struct NotionRoute: Equatable, Sendable {
    public var kind: String; public var name: String; public var dataSourceID: String?; public var reason: String
    public init(kind: String, name: String, dataSourceID: String?, reason: String) { self.kind = kind; self.name = name; self.dataSourceID = dataSourceID; self.reason = reason }
}

public enum MeetingNotion {
    private static let genericDomains: Set<String> = ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me"]
    public static func resolveRoute(title: String, attendees: [String], configuration c: NotionRoutingConfiguration) -> NotionRoute {
        func privateRoute(_ reason: String) -> NotionRoute { .init(kind: "private", name: "Private calls", dataSourceID: c.defaultDataSourceID, reason: reason) }
        let normalized = attendees.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        func validEmail(_ email: String) -> Bool {
            let parts = email.split(separator: "@", omittingEmptySubsequences: false)
            guard parts.count == 2, !parts[0].isEmpty, parts[0].count <= 64, !parts[1].isEmpty,
                  parts[1].contains("."), !parts[1].hasPrefix("."), !parts[1].hasSuffix(".") else { return false }
            return email.range(of: #"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"#, options: .regularExpression) != nil
        }
        guard !normalized.isEmpty, normalized.allSatisfy(validEmail) else { return privateRoute("Attendee identity incomplete") }
        let emails = Set(normalized), owner = c.ownerEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), lowerTitle = title.lowercased()
        if ["[private]", "[no-rec]", "1:1", "1-on-1"].contains(where: lowerTitle.contains) { return privateRoute("Private title marker; no client routing") }
        guard !emails.isEmpty, !owner.isEmpty, emails.contains(owner) else { return privateRoute("Attendee identity incomplete") }
        let others = emails.subtracting([owner])
        let teamMatches = c.team.filter { others.count == 1 && others.isSubset(of: Set($0.emails.map { $0.lowercased() })) }
        if teamMatches.count > 1 { return privateRoute("Ambiguous team alias; private destination not uniquely identified") }
        if let member = teamMatches.first {
            guard let target = member.privateDataSourceID, !target.isEmpty else { return privateRoute("Team 1:1 has no configured private destination") }
            return .init(kind: "one_on_one", name: member.name.isEmpty ? "Private 1:1" : member.name, dataSourceID: target, reason: "Exact attendee email match")
        }
        let internalDomains = Set(c.internalDomains.map { $0.lowercased() })
        let domains = Set(others.compactMap { $0.split(separator: "@", omittingEmptySubsequences: false).last.map(String.init).map { $0.lowercased() } }).subtracting(internalDomains).subtracting(genericDomains)
        let matches = c.clients.filter { !domains.isDisjoint(with: Set($0.domains.map { $0.lowercased() })) }
        guard matches.count == 1 else { return privateRoute("No unique client domain match") }
        let client = matches[0], known = Set(client.domains.map { $0.lowercased() })
        guard domains.isSubset(of: known) else { return privateRoute("Unrecognized external business domain") }
        guard let target = client.dataSourceID, !target.isEmpty else { return privateRoute("Client destination not configured") }
        return .init(kind: "client", name: client.name, dataSourceID: target, reason: "Unique exact attendee domain match")
    }

    public struct Input: Sendable {
        public var id: String; public var title: String; public var callDate: String; public var summaryMethod: String
        public var summary: String; public var actionItems: [String]; public var segments: [Segment]
        public struct Segment: Sendable { public var start: Double; public var speaker: String; public var text: String; public init(start: Double, speaker: String, text: String) { self.start = start; self.speaker = speaker; self.text = text } }
        public init(id: String, title: String, callDate: String, summaryMethod: String = "imported", summary: String, actionItems: [String] = [], segments: [Segment]) { self.id=id; self.title=title; self.callDate=callDate; self.summaryMethod=summaryMethod; self.summary=summary; self.actionItems=actionItems; self.segments=segments }
    }
    public enum BuildError: Error, Equatable { case tooLarge }
    public static func richText(_ value: String) -> [[String: Any]] {
        let chars = Array(value)
        return stride(from: 0, to: chars.count, by: 1900).map { offset in
            let chunk = String(chars[offset..<min(offset + 1900, chars.count)])
            return ["type":"text", "text":["content":chunk]] as [String: Any]
        }
    }
    public static func blocks(for input: Input) throws -> [[String: Any]] {
        let transcript = input.segments.map { String(format: "[%.1fs] %@: %@", $0.start, $0.speaker, $0.text) }.joined(separator: "\n")
        guard input.segments.reduce(0, { $0 + $1.text.count }) <= 95_000 else { throw BuildError.tooLarge }
        let rows: [(String,String)] = [("heading_2", "Notes (\(input.summaryMethod))"), ("paragraph", input.summary.isEmpty ? "No summary supplied." : input.summary), ("heading_2", "Action items")] + input.actionItems.map { ("bulleted_list_item", $0) } + [("heading_2", "Transcript"), ("paragraph", transcript)]
        var result: [[String: Any]] = []
        for (kind, value) in rows {
            let parts = Array(value)
            for offset in stride(from: 0, to: parts.count, by: 1900) {
                let text = String(parts[offset..<min(offset+1900, parts.count)])
                result.append(["object":"block", "type":kind, kind:["rich_text":richText(text)]])
            }
        }
        guard result.count <= 100 else { throw BuildError.tooLarge }
        return result
    }
    public static func identity(for input: Input) -> String { "reel_" + input.id }
    public static func createRequest(for input: Input, parentDataSourceID: String) throws -> [String: Any] {
        ["parent":["type":"data_source_id", "data_source_id":parentDataSourceID], "properties":["Name":["title":richText(input.title)], "Meeting ID":["rich_text":richText(identity(for: input))], "Call Date":["date":["start":input.callDate]]], "children":try blocks(for: input)]
    }
    public static func createRequestData(for input: Input, parentDataSourceID: String) throws -> Data { try JSONSerialization.data(withJSONObject: createRequest(for: input, parentDataSourceID: parentDataSourceID), options: [.sortedKeys]) }
    public static func canonical(_ items: [[String: Any]]) -> [[String: String]] {
        items.map { block in
            let type = block["type"] as? String ?? ""
            let payload = block[type] as? [String: Any] ?? [:]
            let rich = payload["rich_text"] as? [[String: Any]] ?? []
            let text = rich.map { part -> String in
                if let plain = part["plain_text"] as? String { return plain }
                return ((part["text"] as? [String: Any])?["content"] as? String) ?? ""
            }.joined()
            return ["type":type, "text":text]
        }
    }
    public static func readbackMatches(page: [String: Any], expectedParentID: String, input: Input, expectedBlocks: [[String: Any]]) -> Bool {
        guard page["archived"] as? Bool != true, page["in_trash"] as? Bool != true,
              let parent = page["parent"] as? [String: Any], parent["data_source_id"] as? String == expectedParentID,
              let props = page["properties"] as? [String: Any],
              propertyText(props["Meeting ID"], kind: "rich_text") == identity(for: input),
              propertyText(props["Name"], kind: "title") == input.title,
              let actual = page["children"] as? [[String: Any]] else { return false }
        return canonical(actual) == canonical(expectedBlocks)
    }
    private static func propertyText(_ value: Any?, kind: String) -> String {
        guard let object = value as? [String: Any], let prop = object[kind] as? [[String: Any]] else { return "" }
        return prop.map { ($0["plain_text"] as? String) ?? ((($0["text"] as? [String: Any])?["content"] as? String) ?? "") }.joined()
    }
}
