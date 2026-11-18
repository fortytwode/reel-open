import AppKit
import ApplicationServices
import ScreenCaptureKit
import os

/// Raises only a uniquely identified window; AX does not expose an SCWindow's window ID.
@MainActor
enum WindowActivation {
    enum Result { case activated, accessibilityRequired, unavailable, cancelled }
    private static let log = Logger(subsystem: Log.subsystem, category: "window_activation")

    static func activate(_ selected: SCWindow, stillRecording: () -> Bool) async -> Result {
        guard stillRecording() else { return .cancelled }
        guard AXIsProcessTrusted() else {
            log.info("Window activation: accessibility required")
            return .accessibilityRequired
        }
        guard let owner = selected.owningApplication,
              let app = NSRunningApplication(processIdentifier: owner.processID),
              let infos = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            log.info("Window activation: owner or window list unavailable")
            return .unavailable
        }
        let owned = infos.filter {
            ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == owner.processID &&
            ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
        }
        guard let selectedInfo = owned.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == selected.windowID }),
              let bounds = selectedInfo[kCGWindowBounds as String] as? [String: Any],
              let target = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              !target.isEmpty else {
            log.info("Window activation: selected window bounds unavailable")
            return .unavailable
        }
        func close(_ a: CGRect, _ b: CGRect) -> Bool {
            abs(a.minX - b.minX) < 2 && abs(a.minY - b.minY) < 2 &&
            abs(a.width - b.width) < 2 && abs(a.height - b.height) < 2
        }
        // A title can distinguish windows with identical frames. If it is unavailable,
        // geometry alone is safe only when it uniquely identifies the window.
        let title = (selectedInfo[kCGWindowName as String] as? String).flatMap { $0.isEmpty ? nil : $0 }
        func titleMatches(_ candidate: String?) -> Bool {
            guard let title else { return true }
            guard let candidate else { return false }
            if candidate == title { return true }
            guard let name = app.localizedName, !name.isEmpty else { return false }
            return candidate == "\(title) - \(name)"
        }
        let cgMatches = owned.filter { info in
            guard let bounds = info[kCGWindowBounds as String] as? [String: Any],
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  close(frame, target) else { return false }
            return titleMatches(info[kCGWindowName as String] as? String)
        }.count
        guard cgMatches == 1 else {
            log.info("Window activation: CG matches=\(cgMatches)")
            return .unavailable
        }

        let application = AXUIElementCreateApplication(owner.processID)
        AXUIElementSetMessagingTimeout(application, 1)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement] else {
            log.info("Window activation: AX window list unavailable")
            return .unavailable
        }
        let deadline = Date().addingTimeInterval(2)
        var matches: [AXUIElement] = []
        var scanned = 0
        var titleMatchesCount = 0
        for window in windows {
            guard Date() < deadline else {
                log.info("Window activation: deadline windows=\(windows.count) scanned=\(scanned) titleMatches=\(titleMatchesCount) matches=\(matches.count)")
                return .unavailable
            }
            scanned += 1
            AXUIElementSetMessagingTimeout(window, 0.2)
            if title != nil {
                var windowTitle: CFTypeRef?
                guard AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &windowTitle) == .success,
                      titleMatches(windowTitle as? String) else { continue }
            }
            titleMatchesCount += 1
            var position: CFTypeRef?
            var size: CFTypeRef?
            guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position) == .success,
                  AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size) == .success,
                  let position, let size, CFGetTypeID(position) == AXValueGetTypeID(),
                  CFGetTypeID(size) == AXValueGetTypeID() else { continue }
            var point = CGPoint.zero
            var dimensions = CGSize.zero
            guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
                  AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { continue }
            if close(CGRect(origin: point, size: dimensions), target) { matches.append(window) }
        }
        log.info("Window activation: windows=\(windows.count) scanned=\(scanned) titleMatches=\(titleMatchesCount) matches=\(matches.count)")
        guard Date() < deadline, matches.count == 1 else {
            log.info("Window activation: ambiguous match or deadline")
            return .unavailable
        }
        guard stillRecording() else { return .cancelled }
        let firstRaise = AXUIElementPerformAction(matches[0], kAXRaiseAction as CFString)
        guard firstRaise == .success else {
            log.info("Window activation: first raise failed code=\(firstRaise.rawValue)")
            return .unavailable
        }
        guard stillRecording() else { return .cancelled }
        if !app.isActive {
            NSApp.yieldActivation(to: app)
            _ = app.activate(options: [])
        }
        // Activation state is updated on a later main run-loop turn.
        for _ in 0..<20 {
            guard stillRecording() else { return .cancelled }
            if app.isActive { break }
            try? await Task.sleep(for: .milliseconds(50))
        }
        guard stillRecording() else { return .cancelled }
        guard app.isActive else {
            log.info("Window activation: active state timeout")
            return .unavailable
        }
        log.info("Window activation: observed active")
        // The chosen window may have closed while activation was pending.
        var currentWindows: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &currentWindows) == .success,
              let currentAX = currentWindows as? [AXUIElement],
              currentAX.contains(where: { CFEqual($0, matches[0]) }),
              let currentCG = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              currentCG.contains(where: {
                  ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == owner.processID &&
                  ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == selected.windowID
              }) else {
            log.info("Window activation: selected window no longer available")
            return .unavailable
        }
        guard stillRecording() else { return .cancelled }
        let finalRaise = AXUIElementPerformAction(matches[0], kAXRaiseAction as CFString)
        guard finalRaise == .success else {
            log.info("Window activation: final raise failed code=\(finalRaise.rawValue)")
            return .unavailable
        }
        log.info("Window activation: activated")
        return .activated
    }
}
