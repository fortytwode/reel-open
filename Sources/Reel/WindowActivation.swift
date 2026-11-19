import AppKit
import ApplicationServices
import ScreenCaptureKit
import os

/// Raises only a uniquely identified window; AX does not expose an SCWindow's window ID.
@MainActor
enum WindowActivation {
    enum Result: Equatable {
        case activated, accessibilityRequired, unavailable, cancelled

        var warning: String? {
            switch self {
            case .accessibilityRequired: "Allow Accessibility to focus the window"
            case .unavailable: "Click the selected window to focus it"
            case .activated, .cancelled: nil
            }
        }
    }
    private static let log = Logger(subsystem: Log.subsystem, category: "window_activation")

    private static func onScreenWindowIDs(ownerPID: pid_t) -> [CGWindowID] {
        let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return infos.compactMap { info in
            guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == ownerPID,
                  (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 else { return nil }
            return (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value
        }
    }

    static func isFrontmost(windowID: CGWindowID, ownerPID: pid_t) -> Bool {
        NSWorkspace.shared.frontmostApplication?.processIdentifier == ownerPID &&
            onScreenWindowIDs(ownerPID: ownerPID).first == windowID
    }

    static func activate(_ selected: SCWindow, stillRecording: () -> Bool) async -> Result {
        guard stillRecording() else { return .cancelled }
        guard let owner = selected.owningApplication,
              let app = NSRunningApplication(processIdentifier: owner.processID) else {
            return .unavailable
        }
        guard AXIsProcessTrusted() else {
            if isFrontmost(windowID: selected.windowID, ownerPID: owner.processID) { return .activated }
            log.info("Window activation: accessibility required")
            return .accessibilityRequired
        }
        guard let infos = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            log.info("Window activation: window list unavailable")
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
        let window = matches[0]
        guard stillRecording() else { return .cancelled }
        // Place the exact window first before letting the app take activation.
        let firstRaise = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        guard firstRaise == .success else {
            log.info("Window activation: first raise failed code=\(firstRaise.rawValue)")
            return .unavailable
        }
        guard stillRecording() else { return .cancelled }
        if !app.isActive {
            if NSApp.isActive {
                NSApp.yieldActivation(to: app)
                _ = app.activate(from: .current, options: [])
            }
            // A capture can start from a menu or shortcut when Reel isn't the active app.
            // Accessibility can hand off to the owner of the already matched window.
            if !app.isActive {
                let result = AXUIElementSetAttributeValue(application, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
                log.info("Window activation: AX frontmost code=\(result.rawValue)")
            }
        }
        // Activation state is updated on a later main run-loop turn.
        let activationDeadline = ContinuousClock.now + .seconds(1)
        while ContinuousClock.now < activationDeadline {
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
              currentAX.contains(where: { CFEqual($0, window) }),
              let currentCG = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              currentCG.contains(where: {
                  ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == owner.processID &&
                  ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == selected.windowID
              }) else {
            log.info("Window activation: selected window no longer available")
            return .unavailable
        }
        guard stillRecording() else { return .cancelled }
        // Some apps raise a window in their stacking order without giving it keyboard focus.
        var canSetFocus: DarwinBoolean = false
        if AXUIElementIsAttributeSettable(application, kAXFocusedWindowAttribute as CFString, &canSetFocus) == .success,
           canSetFocus.boolValue {
            _ = AXUIElementSetAttributeValue(application, kAXFocusedWindowAttribute as CFString, window)
        }
        let finalRaise = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        guard finalRaise == .success else {
            log.info("Window activation: final raise failed code=\(finalRaise.rawValue)")
            return .unavailable
        }
        AXUIElementSetMessagingTimeout(application, 0.2)
        let focusDeadline = ContinuousClock.now + .seconds(1)
        while ContinuousClock.now < focusDeadline {
            guard stillRecording() else { return .cancelled }
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == owner.processID {
                let visible = onScreenWindowIDs(ownerPID: owner.processID)
                if visible.contains(selected.windowID) {
                    var focused: CFTypeRef?
                    let focusStatus = AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &focused)
                    // Screen sharing can put an auxiliary WindowServer surface above the
                    // focused window, even though the selected window has keyboard focus.
                    let confirmed = focusStatus == .success
                        ? focused.map { CFEqual($0, window) } == true
                        : visible.first == selected.windowID
                    if confirmed {
                        log.info("Window activation: selected window is focused")
                        return .activated
                    }
                }
            }
            try? await Task.sleep(for: .milliseconds(50))
        }
        log.info("Window activation: selected window did not become frontmost")
        return .unavailable
    }
}
