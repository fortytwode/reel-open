import CryptoKit
import Foundation

/// Where recordings live remotely. Keep in sync with web/viewer.js and firebase/storage.rules.
public struct CloudConfig: Decodable, Equatable, Sendable {
    public var projectID: String
    public var bucket: String
    public var apiKey: String
    public var viewerPath: String
    public var viewerBase: URL
    public var googleClientID: String
    public var allowedEmailDomain: String
    public var notesBaseURL: URL
    public var meetingServiceURL: URL
    public var deliveryServiceURL: URL
    public var speechServiceURL: URL
    /// Reel's own named Firestore database (comments, reactions, view counts).
    public var firestoreDatabase: String

    public init(projectID: String, bucket: String, apiKey: String, viewerBase: URL, googleClientID: String, allowedEmailDomain: String, firestoreDatabase: String = "reel", viewerPath: String = "v") {
        self.notesBaseURL = viewerBase.appendingPathComponent(viewerPath)
        self.meetingServiceURL = Self.disabledURL
        self.deliveryServiceURL = Self.disabledURL
        self.speechServiceURL = Self.disabledURL
        self.projectID = projectID
        self.bucket = bucket
        self.apiKey = apiKey
        self.viewerBase = viewerBase
        self.viewerPath = viewerPath
        self.googleClientID = googleClientID
        self.allowedEmailDomain = allowedEmailDomain
        self.firestoreDatabase = firestoreDatabase
    }

    private static let disabledURL = URL(string: "https://unconfigured.invalid")!
    public var isConfigured: Bool { !projectID.isEmpty && !apiKey.isEmpty && !allowedEmailDomain.isEmpty }

    public func permits(email: String) -> Bool {
        let parts = email.split(separator: "@", omittingEmptySubsequences: false)
        return isConfigured && parts.count == 2 && !parts[0].isEmpty
            && !parts[0].contains(where: { $0.isWhitespace || $0 == "<" || $0 == ">" })
            && parts[1].lowercased() == allowedEmailDomain
    }

    private static func validStorageBucket(_ value: String) -> Bool {
        guard value.range(of: #"^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$"#, options: .regularExpression) != nil else { return false }
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        return parts.allSatisfy { !$0.isEmpty && $0.count <= 63 }
            && !(parts.count == 4 && parts.allSatisfy { UInt8($0) != nil })
    }

    /// Only the app bundle supplies trust settings. A plain SwiftPM executable records locally.
    public static func load(from url: URL?) -> CloudConfig? {
        guard let url, let data = try? Data(contentsOf: url),
              let config = try? JSONDecoder().decode(Self.self, from: data), config.isConfigured else { return nil }
        let domainPattern = #"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:[.][a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"#
        guard config.allowedEmailDomain.count <= 253,
              config.allowedEmailDomain.range(of: domainPattern, options: .regularExpression) != nil,
              validStorageBucket(config.bucket),
              config.projectID.range(of: #"^[a-z][a-z0-9-]{4,28}[a-z0-9]$"#, options: .regularExpression) != nil,
              config.apiKey.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil,
              config.googleClientID.hasSuffix(".apps.googleusercontent.com"),
              config.firestoreDatabase.range(of: #"^(?:[a-z][a-z0-9-]*|\(default\))$"#, options: .regularExpression) != nil,
              config.viewerPath.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil else { return nil }
        let services = [config.meetingServiceURL, config.deliveryServiceURL, config.speechServiceURL]
        for endpoint in services + [config.viewerBase, config.notesBaseURL] {
            guard let host = endpoint.host, endpoint.user == nil, endpoint.password == nil else { return nil }
            let localWeb = !services.contains(endpoint) && ["localhost", "127.0.0.1", "[::1]"].contains(host)
            guard endpoint.scheme == "https" || (localWeb && endpoint.scheme == "http") else { return nil }
        }
        return config
    }

    public static let `default` = load(from: Bundle.main.url(forResource: "organization", withExtension: "json"))
        ?? CloudConfig(projectID: "", bucket: "", apiKey: "", viewerBase: disabledURL, googleClientID: "", allowedEmailDomain: "")
}

/// One object of a recording, relative to its location (see `RemoteLocation`): fixed names
/// plus HLS segments (`segNNNNN.m4s`). Keep in sync with firebase/storage.rules `isReelFile`.
public struct RemoteFile: RawRepresentable, Hashable, Sendable, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let video = RemoteFile(rawValue: "video.mp4")
    public static let trimmed = RemoteFile(rawValue: "trimmed.mp4")
    public static let meta = RemoteFile(rawValue: "meta.json")
    public static let transcriptJSON = RemoteFile(rawValue: "transcript.json")
    public static let transcriptText = RemoteFile(rawValue: "transcript.txt")
    public static let thumbnail = RemoteFile(rawValue: "thumb.jpg")
    public static let playlist = RemoteFile(rawValue: "video.m3u8")
    public static let initSegment = RemoteFile(rawValue: "init.mp4")

    /// HLS media segment `n` (1-based): seg00001.m4s, seg00002.m4s, …
    public static func segment(_ n: Int) -> RemoteFile { RemoteFile(rawValue: String(format: "seg%05d.m4s", n)) }

    /// Every fixed (non-segment) file a recording can have.
    public static let fixedFiles: [RemoteFile] = [.meta, .video, .trimmed, .playlist, .initSegment, .transcriptJSON, .transcriptText, .thumbnail]

    public var description: String { rawValue }

    public var isSegment: Bool { rawValue.hasPrefix("seg") && rawValue.hasSuffix(".m4s") }

    /// Mirrors the storage rules' file-name allow-list.
    public var isAllowedByRules: Bool {
        rawValue.range(of: #"^(video\.mp4|trimmed\.mp4|meta\.json|transcript\.json|transcript\.txt|thumb\.jpg|video\.m3u8|init\.mp4|seg[0-9]{5,6}\.m4s)$"#,
                       options: .regularExpression) != nil
    }

    public var contentType: String {
        switch rawValue {
        case "video.mp4", "trimmed.mp4", "init.mp4": "video/mp4"
        case "meta.json", "transcript.json": "application/json"
        case "transcript.txt": "text/plain; charset=utf-8"
        case "thumb.jpg": "image/jpeg"
        case "video.m3u8": "application/vnd.apple.mpegurl"
        default: isSegment ? "video/iso.segment" : "application/octet-stream"
        }
    }
}

/// Where a recording's files live. Public recordings use the flat `reel/v/<id>/` layout (the
/// documented transcript API). Password-protected ones live under `reel/v/<id>/k/<key>/`, where
/// `key` is derived from the password (`AccessKey`) and never stored remotely; their
/// `reel/v/<id>/meta.json` is a stub that only carries the key-derivation salt.
public enum RemoteLocation: Equatable, Hashable, Sendable, Codable {
    case open
    case keyed(String)

    public func prefix(shareID: String) -> String {
        switch self {
        case .open: "reel/v/\(shareID)/"
        case .keyed(let key): "reel/v/\(shareID)/k/\(key)/"
        }
    }

    /// Firestore room for comments/reactions/views (see firebase/firestore.rules).
    public func room(shareID: String) -> String {
        switch self {
        case .open: shareID
        case .keyed(let key): "\(shareID)-\(key)"
        }
    }

    public var isKeyed: Bool { if case .keyed = self { return true } else { return false } }
}

public enum ShareLinks {
    static let idAlphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")

    /// 20 random lowercase alphanumerics (~103 bits). Matches the rules' `^[a-z0-9]{16,40}$`.
    public static func newShareID<G: RandomNumberGenerator>(using generator: inout G) -> String {
        String((0..<20).map { _ in idAlphabet[Int.random(in: 0..<idAlphabet.count, using: &generator)] })
    }

    public static func newShareID() -> String {
        var g = SystemRandomNumberGenerator()
        return newShareID(using: &g)
    }

    /// Public 128-bit nonce, used only for binding a new recording ID to its publisher.
    public static func newRecordingNonce() -> String {
        var generator = SystemRandomNumberGenerator()
        return AccessKey.hex((0..<16).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    }

    public static func ownerBoundShareID(ownerUID: String, recordingNonce: String) -> String? {
        guard !ownerUID.isEmpty, recordingNonce.utf8.count == 32,
              recordingNonce.utf8.allSatisfy(isLowercaseHex) else { return nil }
        let input = Data("reel-owner-v2:\(ownerUID):\(recordingNonce)".utf8)
        return "r2" + AccessKey.hex(Array(SHA256.hash(data: input))).prefix(38)
    }

    public static func isOwnerBoundShareID(_ id: String) -> Bool {
        id.utf8.count == 40 && id.hasPrefix("r2") && id.utf8.dropFirst(2).allSatisfy(isLowercaseHex)
    }

    private static func isLowercaseHex(_ byte: UInt8) -> Bool {
        (48...57).contains(byte) || (97...102).contains(byte)
    }

    public static func isValidShareID(_ id: String) -> Bool {
        (16...40).contains(id.count) && id.allSatisfy { idAlphabet.contains($0) }
    }

    public static func objectPath(shareID: String, file: RemoteFile, location: RemoteLocation = .open) -> String {
        location.prefix(shareID: shareID) + file.rawValue
    }

    /// Storage object names are a single path segment in the REST API, so "/" must be escaped.
    public static func encodedObjectName(_ path: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return path.addingPercentEncoding(withAllowedCharacters: allowed) ?? path
    }

    /// Public, unauthenticated download URL (works for anyone with the share ID, and the key for
    /// protected recordings).
    public static func downloadURL(shareID: String, file: RemoteFile, location: RemoteLocation = .open, config: CloudConfig = .default) -> URL {
        URL(string: "https://firebasestorage.googleapis.com/v0/b/\(config.bucket)/o/\(encodedObjectName(objectPath(shareID: shareID, file: file, location: location)))?alt=media")!
    }

    public static func viewerURL(shareID: String, config: CloudConfig = .default) -> URL {
        config.viewerBase.appendingPathComponent(config.viewerPath).appendingPathComponent(shareID)
    }

    /// Accepts a viewer link (with or without trailing slash, query or #t=), a Storage
    /// download URL, or a bare ID, and returns the share ID.
    public static func shareID(from input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if isValidShareID(trimmed) { return trimmed }
        guard let components = URLComponents(string: trimmed) else { return nil }
        let path = components.percentEncodedPath.removingPercentEncoding ?? components.percentEncodedPath
        let parts = path.split(separator: "/").map(String.init)
        for v in parts.indices where (parts[v] == "v" || parts[v] == "reel" || parts[v] == CloudConfig.default.viewerPath) && v + 1 < parts.count {
            if isValidShareID(parts[v + 1]) { return parts[v + 1] }
        }
        return nil
    }
}
