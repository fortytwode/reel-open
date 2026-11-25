import AppKit
import ReelCore

/// Which work this app does when Reel Recorder and Reel Notetaker are both installed.
@MainActor
enum ProductOwnership {
    static let product = ReelProduct.current
    static let notetakerBundleID = ReelProduct.notetakerBundleID(stateBundleID: ReelProduct.stateBundleID)

    static var notetakerURL: URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: notetakerBundleID) }
    static var notetakerInstalled: Bool { product == .notetaker || notetakerURL != nil }
    static var ownsMeetings: Bool { product.owns(meeting: true, notetakerInstalled: notetakerInstalled) }
    static var ownsClips: Bool { product.owns(meeting: false, notetakerInstalled: notetakerInstalled) }
    static func owns(_ recording: Recording) -> Bool { recording.isMeeting ? ownsMeetings : ownsClips }

    /// Hands a meeting link (reel://join-meeting?…) to Reel Notetaker. False when it is not installed.
    static func forwardToNotetaker(_ url: URL) -> Bool {
        guard product == .recorder, notetakerURL != nil,
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        parts.scheme = ReelProduct.notetaker.urlScheme
        guard let forwarded = parts.url else { return false }
        return NSWorkspace.shared.open(forwarded)
    }

    static var recorderURL: URL? {
        product == .notetaker ? NSWorkspace.shared.urlForApplication(withBundleIdentifier: ReelProduct.stateBundleID) : Bundle.main.bundleURL
    }

    static func openRecorderApp() {
        guard product == .notetaker, let url = recorderURL else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }

    @discardableResult
    static func openNotetakerApp() -> Bool {
        guard product == .recorder, let url = notetakerURL else { return false }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        return true
    }
}
