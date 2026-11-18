import Foundation

/// Firestore REST requests for Reel's named database (`reel`), authorised with the user's
/// Firebase ID token so firebase/firestore.rules apply. Used by the app for the owner's side:
/// creating a recording's room (views/expiry), reading the view count, migrating and deleting.
public struct FirestoreRequests: Sendable {
    public enum Value: Equatable, Sendable {
        case string(String), int(Int), double(Double), bool(Bool), timestamp(Date), null

        var json: [String: Any] {
            switch self {
            case .string(let s): ["stringValue": s]
            case .int(let i): ["integerValue": String(i)]
            case .double(let d): ["doubleValue": d]
            case .bool(let b): ["booleanValue": b]
            case .timestamp(let d): ["timestampValue": FirestoreRequests.timestamp(d)]
            case .null: ["nullValue": NSNull()]
            }
        }

        /// Parses a Firestore REST value object.
        public static func parse(_ any: Any?) -> Value? {
            guard let o = any as? [String: Any] else { return nil }
            if let s = o["stringValue"] as? String { return .string(s) }
            if let s = o["integerValue"] as? String, let i = Int(s) { return .int(i) }
            if let i = o["integerValue"] as? Int { return .int(i) }
            if let d = o["doubleValue"] as? Double { return .double(d) }
            if let b = o["booleanValue"] as? Bool { return .bool(b) }
            if let t = o["timestampValue"] as? String, let d = FirestoreRequests.parseTimestamp(t) { return .timestamp(d) }
            if o["nullValue"] != nil { return .null }
            return nil
        }
    }

    public var config: CloudConfig
    public var idToken: String

    public init(config: CloudConfig = .default, idToken: String) {
        self.config = config
        self.idToken = idToken
    }

    public var documentsBase: String {
        "https://firestore.googleapis.com/v1/projects/\(config.projectID)/databases/\(config.firestoreDatabase)/documents"
    }

    static func timestamp(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }

    static func parseTimestamp(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    public static func body(_ fields: [String: Value]) -> Data {
        try! JSONSerialization.data(withJSONObject: ["fields": fields.mapValues(\.json)], options: [.sortedKeys])
    }

    /// `fields` of a REST document → plain values.
    public static func fields(of document: [String: Any]) -> [String: Value] {
        ((document["fields"] as? [String: Any]) ?? [:]).compactMapValues { Value.parse($0) }
    }

    func request(_ url: String, method: String, body: Data? = nil) -> URLRequest {
        var r = URLRequest(url: URL(string: url)!)
        r.httpMethod = method
        r.timeoutInterval = 30
        r.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")
        if let body {
            r.httpBody = body
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    public func createRoom(_ room: String, ownerUID: String, createdAt: Date, views: Int = 0, expiresAt: Date?) -> URLRequest {
        let fields: [String: Value] = ["ownerUid": .string(ownerUID), "createdAt": .timestamp(createdAt), "views": .int(views),
                                       "expiresAt": expiresAt.map(Value.timestamp) ?? .null]
        return request("\(documentsBase)/videos?documentId=\(room)", method: "POST", body: Self.body(fields))
    }

    public func setRoomExpiry(_ room: String, expiresAt: Date?) -> URLRequest {
        request("\(documentsBase)/videos/\(room)?updateMask.fieldPaths=expiresAt", method: "PATCH",
                body: Self.body(["expiresAt": expiresAt.map(Value.timestamp) ?? .null]))
    }

    public func setRoomTitle(_ room: String, title: String) -> URLRequest {
        request("\(documentsBase)/videos/\(room)?updateMask.fieldPaths=titleOverride", method: "PATCH",
                body: Self.body(["titleOverride": .string(title)]))
    }

    /// Private owner-only listing metadata. Never includes a password, key, or storage path.
    public func upsertLibraryEntry(_ recording: Recording, ownerUID: String, status: String) -> URLRequest {
        let fields: [String: Value] = ["id": .string(recording.shareID), "title": .string(recording.title),
            "createdAt": .timestamp(recording.createdAt), "durationSeconds": .double(recording.durationSeconds),
            "status": .string(status)]
        let uid = ShareLinks.encodedObjectName(ownerUID)
        return request("\(documentsBase)/users/\(uid)/recordings/\(recording.shareID)", method: "PATCH", body: Self.body(fields))
    }

    public func deleteLibraryEntry(_ shareID: String, ownerUID: String) -> URLRequest {
        let uid = ShareLinks.encodedObjectName(ownerUID)
        return request("\(documentsBase)/users/\(uid)/recordings/\(shareID)", method: "DELETE")
    }

    public func getRoom(_ room: String) -> URLRequest { request("\(documentsBase)/videos/\(room)", method: "GET") }

    public func list(_ room: String, collection: String, pageToken: String? = nil) -> URLRequest {
        var url = "\(documentsBase)/videos/\(room)/\(collection)?pageSize=300"
        if let pageToken { url += "&pageToken=\(pageToken.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? pageToken)" }
        return request(url, method: "GET")
    }

    public func create(_ room: String, collection: String, fields: [String: Value]) -> URLRequest {
        request("\(documentsBase)/videos/\(room)/\(collection)", method: "POST", body: Self.body(fields))
    }

    /// `name` is a full document resource name as returned by `list`, or nil for the room itself.
    public func delete(room: String, documentName: String? = nil) -> URLRequest {
        if let documentName { return request("https://firestore.googleapis.com/v1/\(documentName)", method: "DELETE") }
        return request("\(documentsBase)/videos/\(room)", method: "DELETE")
    }
}
