import AppKit
import Foundation
import Sparkle

/// In-app updates via Sparkle 2 (see docs/RELEASING.md). Reel is unsandboxed, so the standard
/// updater (no XPC services) is enough. Scheduled checks are silent when nothing is new or the feed
/// is unreachable; only "Check for Updates…" shows errors to the user.
@MainActor
final class Updater: NSObject, SPUUpdaterDelegate, NSMenuItemValidation {
    static let shared = Updater()

    private var controller: SPUStandardUpdaterController?

    /// Only a packaged Reel.app with a feed URL can update itself (not `swift run` or CLI test modes).
    var isAvailable: Bool {
        Bundle.main.bundleURL.pathExtension == "app"
            && !((Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String) ?? "").isEmpty
    }

    func start() {
        guard controller == nil, isAvailable else { return }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
    }

    var canCheckForUpdates: Bool { controller?.updater.canCheckForUpdates ?? false }

    @objc func checkForUpdates(_ sender: Any?) {
        NSApp.activate(ignoringOtherApps: true)
        controller?.checkForUpdates(sender)
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        menuItem.action == #selector(checkForUpdates(_:)) ? canCheckForUpdates : true
    }

    nonisolated func updater(_ updater: SPUUpdater, didAbortWithError error: any Error) {
        // Expected while offline or before the feed is live: log, never alert.
        Log.app.info("Update check ended: \(error.localizedDescription, privacy: .public)")
    }
}
