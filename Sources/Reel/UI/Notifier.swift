import AppKit
import UserNotifications

/// macOS notifications; clicking one opens its link.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    static var enabled = true

    func setUp() {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            Log.app.info("Notifications \(granted ? "allowed" : "not allowed")")
        }
    }

    static func post(title: String, body: String, url: URL?) {
        guard enabled, Bundle.main.bundleIdentifier != nil else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if let url { content.userInfo = ["url": url.absoluteString] }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        if let s = response.notification.request.content.userInfo["url"] as? String, let url = URL(string: s) { NSWorkspace.shared.open(url) }
        done()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }
}

enum Sound {
    enum Cue { case start, pause, stop }
    static var enabled = true
    static func play(_ cue: Cue) {
        guard enabled else { return }
        let name: String = switch cue {
        case .start: "Tink"
        case .pause: "Pop"
        case .stop: "Glass"
        }
        NSSound(named: NSSound.Name(name))?.play()
    }
}
