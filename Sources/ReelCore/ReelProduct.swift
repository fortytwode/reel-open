import Foundation

/// One binary ships as two apps. Reel Recorder makes and shares screen
/// recordings. Reel Notetaker joins, records and documents meetings. The app
/// bundle's Info.plist selects the product, so both can be installed and run
/// together without doing each other's work.
public enum ReelProduct: String, Sendable {
    case recorder, notetaker

    public static let current = ReelProduct(infoValue: Bundle.main.object(forInfoDictionaryKey: "ReelProduct"))

    public init(infoValue: Any?) {
        self = (infoValue as? String).flatMap(ReelProduct.init(rawValue:)) ?? .recorder
    }

    public var displayName: String { self == .notetaker ? "Reel Notetaker" : "Reel Recorder" }
    public var urlScheme: String { self == .notetaker ? "reel-notetaker" : "reel" }

    /// Both apps keep one sign-in and one set of meeting choices: the Recorder's.
    public static let stateBundleID = stateBundleID(
        shared: Bundle.main.object(forInfoDictionaryKey: "ReelStateBundleID"), own: Bundle.main.bundleIdentifier)

    public static func stateBundleID(shared: Any?, own: String?) -> String {
        if let shared = shared as? String, !shared.isEmpty { return shared }
        return own ?? "org.reel.app"
    }

    public static func notetakerBundleID(stateBundleID: String) -> String { stateBundleID + ".notetaker" }

    /// Notetaker owns meetings. Recorder owns screen recordings, and keeps
    /// handling meetings only on a Mac where Notetaker is not installed, so an
    /// updated Recorder alone behaves as before.
    public func owns(meeting: Bool, notetakerInstalled: Bool) -> Bool {
        switch self {
        case .notetaker: return meeting
        case .recorder: return !meeting || !notetakerInstalled
        }
    }
}
