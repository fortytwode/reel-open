import Foundation
import ReelCore

/// Owner-side access to Reel's Firestore database (`reel`): the room document that holds the
/// view count and expiry, and migration/deletion of comments and reactions. Viewers write
/// reactions, comments and views directly from the web page (firebase/firestore.rules).
struct FirestoreClient {
    let requests: FirestoreRequests
    let ownerUID: String
    var session: URLSession = .shared

    init(cloud: CloudSession, config: CloudConfig = .default) {
        requests = FirestoreRequests(config: config, idToken: cloud.idToken)
        ownerUID = cloud.userID
    }

    /// Creates the room if missing; otherwise updates its expiry.
    func ensureRoom(_ room: String, createdAt: Date, expiresAt: Date?, views: Int = 0) async throws {
        let (data, code) = try await send(requests.createRoom(room, ownerUID: ownerUID, createdAt: createdAt, views: views, expiresAt: expiresAt))
        if (200..<300).contains(code) { return }
        if code == 409 { return try await setExpiry(room, expiresAt: expiresAt) }
        throw CloudError.message("Couldn't create the comments room (HTTP \(code)) \(String(data: data.prefix(200), encoding: .utf8) ?? "")")
    }

    func setExpiry(_ room: String, expiresAt: Date?) async throws {
        let (data, code) = try await send(requests.setRoomExpiry(room, expiresAt: expiresAt))
        guard (200..<300).contains(code) || code == 404 else {
            throw CloudError.message("Couldn't update link expiry (HTTP \(code)) \(String(data: data.prefix(200), encoding: .utf8) ?? "")")
        }
    }

    /// Backfill must not adopt another account's local recordings after an account switch.
    func ownsRoom(_ room: String) async throws -> Bool {
        let (data, code) = try await send(requests.getRoom(room))
        if code == 403 || code == 404 { return false }
        guard (200..<300).contains(code), let doc = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CloudError.message("Couldn't check online library ownership (HTTP \(code))")
        }
        return FirestoreRequests.fields(of: doc)["ownerUid"] == .string(ownerUID)
    }

    func upsertLibraryEntry(_ recording: Recording, status: String = "ready") async throws {
        let (_, code) = try await send(requests.upsertLibraryEntry(recording, ownerUID: ownerUID, status: status))
        guard (200..<300).contains(code) else {
            throw CloudError.message("Couldn't update your online library (HTTP \(code)). Retry the upload from the local Library.")
        }
    }

    func deleteLibraryEntry(_ shareID: String) async throws {
        let (_, code) = try await send(requests.deleteLibraryEntry(shareID, ownerUID: ownerUID))
        guard (200..<300).contains(code) || code == 404 else {
            throw CloudError.message("Couldn't remove the online library entry (HTTP \(code)). Retry deletion from the local Library.")
        }
    }

    /// The room's view count, nil if the room doesn't exist.
    func views(_ room: String) async throws -> Int? {
        let (data, code) = try await send(requests.getRoom(room))
        if code == 404 || code == 403 { return nil }
        guard (200..<300).contains(code), let doc = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CloudError.message("Couldn't read views (HTTP \(code))")
        }
        if case .int(let n)? = FirestoreRequests.fields(of: doc)["views"] { return n }
        return 0
    }

    /// Documents (name + fields) of a room's subcollection.
    func list(_ room: String, collection: String) async throws -> [(name: String, fields: [String: FirestoreRequests.Value])] {
        var out: [(String, [String: FirestoreRequests.Value])] = []
        var token: String?
        repeat {
            let (data, code) = try await send(requests.list(room, collection: collection, pageToken: token))
            if code == 404 || code == 403 { return out }
            guard (200..<300).contains(code), let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw CloudError.message("Couldn't list \(collection) (HTTP \(code))")
            }
            for d in (json["documents"] as? [[String: Any]]) ?? [] {
                if let name = d["name"] as? String { out.append((name, FirestoreRequests.fields(of: d))) }
            }
            token = json["nextPageToken"] as? String
        } while token != nil
        return out
    }

    /// Copies views, reactions and comments to another room (password changed) and deletes the
    /// old room, so its comments aren't readable by people who only knew the old link/password.
    func migrate(from old: String, to new: String, createdAt: Date, expiresAt: Date?) async throws {
        let response = try? await send(requests.getRoom(old))
        var fields: [String: FirestoreRequests.Value]?
        if let (data, code) = response, (200..<300).contains(code),
           let document = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            fields = FirestoreRequests.fields(of: document)
        }
        let views: Int? = fields.map { if case .int(let n)? = $0["views"] { return n }; return 0 }
        var title: String?
        if fields?["ownerUid"] == .string(ownerUID), case .string(let value)? = fields?["titleOverride"],
           !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.utf16.count <= 500 {
            title = value
        }
        try await ensureRoom(new, createdAt: createdAt, expiresAt: expiresAt, views: views ?? 0)
        guard views != nil else { return }
        if let title {
            let (_, titleCode) = try await send(requests.setRoomTitle(new, title: title))
            guard (200..<300).contains(titleCode) else {
                throw CloudError.message("Couldn't preserve the shared title (HTTP \(titleCode))")
            }
        }
        for (_, fields) in try await list(old, collection: "reactions") {
            _ = try await send(requests.create(new, collection: "reactions", fields: fields))
        }
        for (_, var fields) in try await list(old, collection: "comments") {
            fields["migrated"] = .bool(true)
            _ = try await send(requests.create(new, collection: "comments", fields: fields))
        }
        try await deleteRoom(old)
    }

    func deleteRoom(_ room: String) async throws {
        for collection in ["reactions", "comments"] {
            for (name, _) in try await list(room, collection: collection) {
                _ = try await send(requests.delete(room: room, documentName: name))
            }
        }
        let (_, code) = try await send(requests.delete(room: room))
        guard (200..<300).contains(code) || code == 404 || code == 403 else {
            throw CloudError.message("Couldn't delete comments room (HTTP \(code))")
        }
    }

    private func send(_ req: URLRequest) async throws -> (Data, Int) {
        let (data, resp) = try await session.data(for: req)
        return (data, (resp as? HTTPURLResponse)?.statusCode ?? 0)
    }
}
