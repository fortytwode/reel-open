import CryptoKit
import Foundation

/// Local state belongs to the deployment in the app bundle, including before anyone signs in.
public struct OrganizationState {
    public static let current = OrganizationState(config: .default)
    public static let defaults = UserDefaults(suiteName: current.defaultsSuite)!

    private let identifier: String
    public let defaultsSuite: String
    public var sessionService: String { defaultsSuite + ".firebase" }
    public var notionService: String { defaultsSuite + ".notion" }

    public init(config: CloudConfig, bundleID: String = ReelProduct.stateBundleID) {
        if config.isConfigured {
            // A digest keeps even a maximum-length email domain within filesystem name limits.
            let identity = Data("\(config.projectID)\n\(config.allowedEmailDomain)".utf8)
            identifier = SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
        } else {
            identifier = "local"
        }
        defaultsSuite = "\(bundleID).organization.\(identifier)"
    }

    public func directory(under base: URL) -> URL {
        base.appendingPathComponent("Reel", isDirectory: true)
            .appendingPathComponent("organizations", isDirectory: true)
            .appendingPathComponent(identifier, isDirectory: true)
    }
}
