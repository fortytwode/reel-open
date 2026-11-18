import Foundation
import ReelCore
import Security

struct CloudSession: Codable, Equatable {
    var userID: String
    var email: String
    var displayName: String?
    var refreshToken: String
    var idToken: String
    var expiresAt: Date
}

enum CloudError: LocalizedError {
    case message(String)
    /// Not worth retrying (403/400: rules or request rejected).
    case permanent(String)
    var errorDescription: String? {
        switch self {
        case .message(let t), .permanent(let t): t
        }
    }
    var isPermanent: Bool { if case .permanent = self { return true } else { return false } }
}

struct SessionKeychain {
    let service: String
    func load() -> CloudSession? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: "session", kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(CloudSession.self, from: data)
    }
    func save(_ s: CloudSession) {
        guard let data = try? JSONEncoder().encode(s) else { return }
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "session"]
        if SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecItemNotFound {
            var add = q
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }
    func clear() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "session"] as CFDictionary)
    }
}

/// Firebase Auth over REST (Identity Toolkit + Secure Token), same flow as Jot:
/// Google ID token → signInWithIdp → Firebase ID/refresh tokens.
actor CloudAuth {
    static let shared = CloudAuth()
    private let config: CloudConfig
    private let keychain: SessionKeychain
    private var session: CloudSession?
    /// Test/automation override (REEL_TEST_EMAIL / REEL_TEST_PASSWORD), never persisted.
    private var ephemeral = false

    init(config: CloudConfig = .default) {
        self.config = config
        self.keychain = SessionKeychain(service: OrganizationState(config: config).sessionService)
        if config.isConfigured, let saved = keychain.load(), Self.matchesAccount(saved.idToken, config: config, uid: saved.userID, email: saved.email) {
            self.session = saved
        }
    }

    // Tokens come from Firebase over TLS or from the Keychain, including sessions saved by older versions.
    private static func matchesAccount(_ token: String, config: CloudConfig, uid: String, email: String) -> Bool {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return false }
        var payload = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let bytes = Data(base64Encoded: payload),
              let claims = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let verifiedEmail = claims["email"] as? String, config.permits(email: verifiedEmail) else { return false }
        return claims["aud"] as? String == config.projectID && claims["sub"] as? String == uid
            && claims["iss"] as? String == "https://securetoken.google.com/\(config.projectID)"
            && claims["email_verified"] as? Bool == true && verifiedEmail.lowercased() == email.lowercased()
    }

    var current: CloudSession? { session }

    func signInWithGoogle(idToken: String) async throws -> CloudSession {
        var form = URLComponents()
        form.queryItems = [URLQueryItem(name: "id_token", value: idToken), URLQueryItem(name: "providerId", value: "google.com")]
        let body = try JSONSerialization.data(withJSONObject: [
            "postBody": (form.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B"),
            "requestUri": "http://localhost", "returnSecureToken": true,
        ])
        let r = try await post("https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=\(config.apiKey)", body: body)
        return try store(r, fallbackEmail: nil)
    }

    /// Email/password sign-in, used only by the command-line verification path.
    func signInWithPassword(email: String, password: String) async throws -> CloudSession {
        let body = try JSONSerialization.data(withJSONObject: ["email": email, "password": password, "returnSecureToken": true])
        let r = try await post("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=\(config.apiKey)", body: body)
        ephemeral = true
        return try store(r, fallbackEmail: email)
    }

    private func store(_ r: [String: Any], fallbackEmail: String?) throws -> CloudSession {
        guard let uid = r["localId"] as? String, let refresh = r["refreshToken"] as? String, let token = r["idToken"] as? String else {
            throw CloudError.message("Sign-in response was incomplete. Please try again.")
        }
        let email = (r["email"] as? String) ?? fallbackEmail ?? ""
        guard Self.matchesAccount(token, config: config, uid: uid, email: email) else {
            throw CloudError.message("Sign in with your @\(config.allowedEmailDomain) Google account to upload.")
        }
        let s = CloudSession(userID: uid, email: email, displayName: r["displayName"] as? String ?? r["fullName"] as? String,
                             refreshToken: refresh, idToken: token,
                             expiresAt: Date().addingTimeInterval(Double(r["expiresIn"] as? String ?? "3600") ?? 3600))
        session = s
        if !ephemeral { keychain.save(s) }
        return s
    }

    /// A valid ID token, refreshed when within two minutes of expiry.
    func validSession() async throws -> CloudSession {
        guard let s = session else { throw CloudError.message("Not signed in. Open Reel ▸ Settings ▸ Sign in with Google to enable sharing.") }
        if s.expiresAt > Date().addingTimeInterval(120) { return s }
        var c = URLComponents()
        c.queryItems = [URLQueryItem(name: "grant_type", value: "refresh_token"), URLQueryItem(name: "refresh_token", value: s.refreshToken)]
        let r = try await post("https://securetoken.googleapis.com/v1/token?key=\(config.apiKey)",
                               body: Data((c.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B").utf8),
                               contentType: "application/x-www-form-urlencoded")
        guard let token = r["id_token"] as? String, let uid = r["user_id"] as? String, uid == s.userID,
              Self.matchesAccount(token, config: config, uid: uid, email: s.email), let refresh = r["refresh_token"] as? String else {
            throw CloudError.message("Please sign in again to resume uploads.")
        }
        guard session?.userID == s.userID, session?.refreshToken == s.refreshToken else {
            throw CloudError.message("Your account changed. Please try again with the current account.")
        }
        var n = s
        n.idToken = token
        n.refreshToken = refresh
        n.expiresAt = Date().addingTimeInterval(Double(r["expires_in"] as? String ?? "3600") ?? 3600)
        session = n
        if !ephemeral { keychain.save(n) }
        return n
    }

    func signOut() {
        session = nil
        keychain.clear()
    }

    private func post(_ url: String, body: Data, contentType: String = "application/json") async throws -> [String: Any] {
        guard config.isConfigured else { throw CloudError.message("Cloud sharing is not configured for this build.") }
        var req = URLRequest(url: URL(string: url)!)
        req.httpMethod = "POST"
        req.httpBody = body
        req.timeoutInterval = 25
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        let (data, response) = try await URLSession.shared.data(for: req)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let code = (json["error"] as? [String: Any])?["message"] as? String ?? "HTTP error"
            if ["INVALID_REFRESH_TOKEN", "TOKEN_EXPIRED", "USER_NOT_FOUND", "USER_DISABLED"].contains(code) {
                session = nil
                keychain.clear()
                throw CloudError.message("Please sign in again to resume uploads.")
            }
            throw CloudError.message("Sign-in failed (\(code)).")
        }
        return json
    }
}
