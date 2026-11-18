import AppKit
import AuthenticationServices
import CryptoKit
import Foundation
import Security
import ReelCore

/// Native browser OAuth. The returned Google ID token must still be exchanged
/// with Firebase, which verifies Google's signature before establishing a user.
@MainActor final class GoogleLogin: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let clientID: String
    private let network: URLSession
    private var webSession: ASWebAuthenticationSession?
    private var callback: CheckedContinuation<URL, Error>?
    private var callbackID: UUID?
    private var anchor: NSWindow?
    private var inProgress = false

    init(clientID: String = CloudConfig.default.googleClientID, session: URLSession = .shared) {
        self.clientID = clientID
        self.network = session
    }

    func signIn(presenting window: NSWindow) async throws -> String {
        guard !inProgress else { throw GoogleLoginError.alreadyInProgress }
        inProgress = true
        anchor = window
        defer { inProgress = false; anchor = nil; webSession = nil }
        let verifier = try GoogleOAuthFlow.randomValue(byteCount: 64)
        let state = try GoogleOAuthFlow.randomValue()
        let nonce = try GoogleOAuthFlow.randomValue()
        let scheme = try GoogleOAuthFlow.callbackScheme(clientID: clientID)
        let authorizationURL = try GoogleOAuthFlow.authorizationURL(clientID: clientID, verifier: verifier, state: state, nonce: nonce)
        let callbackURL = try await receiveCallback(authorizationURL: authorizationURL, scheme: scheme)
        try Task.checkCancellation()
        let code = try GoogleOAuthFlow.authorizationCode(callbackURL: callbackURL, clientID: clientID, expectedState: state)
        let request = try GoogleOAuthFlow.tokenRequest(clientID: clientID, code: code, verifier: verifier)
        let data: Data
        let response: URLResponse
        do { (data, response) = try await network.data(for: request) }
        catch {
            if Task.isCancelled { throw CancellationError() }
            throw GoogleLoginError.connectionFailed
        }
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw GoogleLoginError.exchangeFailed }
        struct TokenResponse: Decodable { let id_token: String }
        guard let token = try? JSONDecoder().decode(TokenResponse.self, from: data).id_token else { throw GoogleLoginError.invalidIDToken }
        try GoogleOAuthFlow.validateIDTokenClaims(token, clientID: clientID, nonce: nonce)
        return token
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // The session can only be started after signIn supplies its window.
        anchor!
    }

    private func receiveCallback(authorizationURL: URL, scheme: String) async throws -> URL {
        let identifier = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                callback = continuation
                callbackID = identifier
                let session = ASWebAuthenticationSession(url: authorizationURL, callbackURLScheme: scheme) { [weak self] url, error in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        if let error {
                            let nsError = error as NSError
                            if nsError.domain == ASWebAuthenticationSessionErrorDomain,
                               nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                                finish(.failure(CancellationError()), for: identifier)
                            } else { finish(.failure(GoogleLoginError.presentationFailed), for: identifier) }
                        } else if let url { finish(.success(url), for: identifier) }
                        else { finish(.failure(GoogleLoginError.invalidCallback), for: identifier) }
                    }
                }
                webSession = session
                session.presentationContextProvider = self
                session.prefersEphemeralWebBrowserSession = false
                if !session.start() { finish(.failure(GoogleLoginError.presentationFailed), for: identifier) }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard callbackID == identifier else { return }
                webSession?.cancel()
                finish(.failure(CancellationError()), for: identifier)
            }
        }
    }

    private func finish(_ result: Result<URL, Error>, for identifier: UUID) {
        guard callbackID == identifier, let callback else { return }
        self.callback = nil
        callbackID = nil
        webSession = nil
        callback.resume(with: result)
    }
}

enum GoogleLoginError: LocalizedError {
    case invalidConfiguration, randomGenerationFailed, alreadyInProgress
    case presentationFailed, invalidCallback, authorizationFailed
    case connectionFailed, exchangeFailed, invalidIDToken

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: return "Google sign-in is not configured for Reel."
        case .randomGenerationFailed: return "Could not securely start Google sign-in. Please try again."
        case .alreadyInProgress: return "Google sign-in is already open."
        case .presentationFailed: return "Could not open Google sign-in. Please try again."
        case .invalidCallback: return "Google sign-in could not be verified. Please try again."
        case .authorizationFailed: return "Google did not complete sign-in. Please try again."
        case .connectionFailed: return "Could not reach Google. Check your connection and try again."
        case .exchangeFailed: return "Google sign-in could not be completed. Please try again."
        case .invalidIDToken: return "Google’s sign-in response could not be verified. Please try again."
        }
    }
}

/// Pure helpers keep OAuth parsing and request construction testable without
/// opening a browser or exposing credentials in test output.
enum GoogleOAuthFlow {
    static let redirectPath = "/oauthredirect"

    static func callbackScheme(clientID: String) throws -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_")
        guard clientID.hasSuffix(".apps.googleusercontent.com"), clientID.count > ".apps.googleusercontent.com".count,
              clientID.unicodeScalars.allSatisfy({ allowed.contains($0) }),
              !clientID.contains("..") else { throw GoogleLoginError.invalidConfiguration }
        return clientID.split(separator: ".").reversed().joined(separator: ".")
    }

    static func redirectURI(clientID: String) throws -> String {
        try callbackScheme(clientID: clientID) + ":" + redirectPath
    }

    static func randomValue(byteCount: Int = 32) throws -> String {
        guard (32...96).contains(byteCount) else { throw GoogleLoginError.randomGenerationFailed }
        var bytes = [UInt8](repeating: 0, count: byteCount)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw GoogleLoginError.randomGenerationFailed }
        return base64URL(Data(bytes))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func challenge(verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func authorizationURL(clientID: String, verifier: String, state: String, nonce: String) throws -> URL {
        var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: try redirectURI(clientID: clientID)),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: "openid email profile"),
            URLQueryItem(name: "code_challenge", value: challenge(verifier: verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "nonce", value: nonce),
            URLQueryItem(name: "hd", value: CloudConfig.default.allowedEmailDomain),
            URLQueryItem(name: "prompt", value: "select_account")
        ]
        guard let url = components.url else { throw GoogleLoginError.invalidConfiguration }
        return url
    }

    static func authorizationCode(callbackURL: URL, clientID: String, expectedState: String) throws -> String {
        let scheme = try callbackScheme(clientID: clientID)
        guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              components.scheme == scheme, components.host == nil, components.port == nil,
              components.user == nil, components.password == nil,
              components.percentEncodedPath == redirectPath, components.fragment == nil else { throw GoogleLoginError.invalidCallback }
        var values: [String: String] = [:]
        for item in components.queryItems ?? [] {
            guard values[item.name] == nil, let value = item.value else { throw GoogleLoginError.invalidCallback }
            values[item.name] = value
        }
        guard !expectedState.isEmpty, values["state"] == expectedState else { throw GoogleLoginError.invalidCallback }
        if let error = values["error"] {
            guard values["code"] == nil else { throw GoogleLoginError.invalidCallback }
            if error == "access_denied" { throw CancellationError() }
            throw GoogleLoginError.authorizationFailed
        }
        guard let code = values["code"], !code.isEmpty else { throw GoogleLoginError.invalidCallback }
        return code
    }

    static func formEncoded(_ values: [String: String]) -> Data {
        func encode(_ value: String) -> String {
            value.utf8.map { byte -> String in
                switch byte {
                case 65...90, 97...122, 48...57, 45, 46, 95, 126: return String(UnicodeScalar(byte))
                case 32: return "+"
                default: return String(format: "%%%02X", byte)
                }
            }.joined()
        }
        return Data(values.keys.sorted().map { encode($0) + "=" + encode(values[$0]!) }.joined(separator: "&").utf8)
    }

    static func tokenRequest(clientID: String, code: String, verifier: String) throws -> URLRequest {
        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = formEncoded([
            "client_id": clientID, "code": code, "code_verifier": verifier,
            "grant_type": "authorization_code", "redirect_uri": try redirectURI(clientID: clientID)
        ])
        return request
    }

    /// These are request-binding checks, not signature verification. Only a
    /// successful Firebase exchange may treat the token as a signed identity.
    static func validateIDTokenClaims(_ token: String, clientID: String, nonce: String, now: Date = Date()) throws {
        func decodeSegment(_ segment: Substring) -> [String: Any]? {
            var value = String(segment).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            value += String(repeating: "=", count: (4 - value.count % 4) % 4)
            guard let data = Data(base64Encoded: value) else { return nil }
            return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
        let segments = token.split(separator: ".", omittingEmptySubsequences: false)
        guard segments.count == 3, segments.allSatisfy({ !$0.isEmpty }),
              let header = decodeSegment(segments[0]), header["alg"] as? String == "RS256",
              let claims = decodeSegment(segments[1]),
              !nonce.isEmpty, claims["nonce"] as? String == nonce,
              let issuer = claims["iss"] as? String, ["accounts.google.com", "https://accounts.google.com"].contains(issuer),
              let subject = claims["sub"] as? String, !subject.isEmpty,
              let expires = claims["exp"] as? Double, expires.isFinite, expires > now.timeIntervalSince1970,
              let issued = claims["iat"] as? Double, issued.isFinite, issued <= now.timeIntervalSince1970 + 60 else { throw GoogleLoginError.invalidIDToken }
        let audienceMatches = (claims["aud"] as? String) == clientID || ((claims["aud"] as? [String])?.contains(clientID) == true)
        guard audienceMatches else { throw GoogleLoginError.invalidIDToken }
        if let authorizedParty = claims["azp"] as? String, authorizedParty != clientID { throw GoogleLoginError.invalidIDToken }
        if let audiences = claims["aud"] as? [String], audiences.count > 1, claims["azp"] as? String != clientID { throw GoogleLoginError.invalidIDToken }
    }
}
