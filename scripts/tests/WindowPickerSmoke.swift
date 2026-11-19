import AppKit
import ApplicationServices
import CoreImage
import ScreenCaptureKit

// Requires Screen Recording access and a normal app window on another desktop/Space.
// Build ReelCore first, then set PRODUCTS to the build products directory containing
// ReelCore.swiftmodule and ReelCore.o. Run from the repository root:
// swiftc -parse-as-library -I "$PRODUCTS" "$PRODUCTS/ReelCore.o" \
//   Sources/Reel/Log.swift Sources/Reel/Capture/ScreenCapture.swift Sources/Reel/WindowActivation.swift \
//   Sources/Reel/UI/WindowPicker.swift scripts/tests/WindowPickerSmoke.swift -o /tmp/reel-window-picker-smoke
// /tmp/reel-window-picker-smoke
// Add --desktop-hit-test-only to run without the other-Space fixture.
// Add --show-picker to inspect the production picker with a generated, non-private fixture.
// Add --window-activation-only to test exact activation during capture of a generated window.
@main @MainActor
struct WindowPickerSmoke {
    static func main() {
        let app = NSApplication.shared
        if CommandLine.arguments.contains("--activation-fixture") {
            app.setActivationPolicy(.regular)
            let selected = activationFixture(title: "Reel test blue target", color: NSColor(srgbRed: 0.1, green: 0.4, blue: 0.9, alpha: 1))
            let sibling = activationFixture(title: "Reel test red sibling", color: .systemRed)
            selected.orderFrontRegardless()
            sibling.orderFrontRegardless()
            print(selected.windowNumber)
            fflush(stdout)
            withExtendedLifetime([selected, sibling]) { app.run() }
            return
        }
        if CommandLine.arguments.contains("--accessory-fixture") {
            app.setActivationPolicy(.accessory)
            let window = NSWindow(contentRect: NSRect(x: 160, y: 160, width: 480, height: 300),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Reel accessory window fixture"
            window.isReleasedWhenClosed = false
            window.orderFrontRegardless()
            let passthrough = floatingFixture(frame: window.frame, ignoresMouseEvents: true)
            let blocker = floatingFixture(frame: NSRect(x: window.frame.minX, y: window.frame.minY,
                                                        width: window.frame.width / 2, height: window.frame.height),
                                          ignoresMouseEvents: false)
            withExtendedLifetime([window, passthrough, blocker]) { app.run() }
            return
        }
        app.setActivationPolicy(.regular)
        Task {
            do { try await run(); exit(0) }
            catch {
                FileHandle.standardError.write(Data("Window picker smoke failed: \(error)\n".utf8))
                exit(1)
            }
        }
        app.run()
    }

    static func activationFixture(title: String, color: NSColor) -> NSWindow {
        let screen = NSScreen.screens.first?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        let window = NSWindow(contentRect: NSRect(x: screen.midX - 360, y: screen.minY + 24, width: 720, height: 420),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = title
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        window.backgroundColor = color
        return window
    }

    static func floatingFixture(frame: NSRect, ignoresMouseEvents: Bool) -> NSWindow {
        let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.level = .floating
        window.ignoresMouseEvents = ignoresMouseEvents
        window.backgroundColor = ignoresMouseEvents ? NSColor.systemOrange.withAlphaComponent(0.08) : .systemOrange
        window.isOpaque = !ignoresMouseEvents
        window.hasShadow = false
        window.orderFrontRegardless()
        return window
    }

    static func run() async throws {
        if CommandLine.arguments.contains("--window-activation-only") {
            try await checkWindowActivation()
            return
        }
        if CommandLine.arguments.contains("--desktop-hit-test-only") {
            try await checkAccessoryWindow()
            return
        }
        let all = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        let pid = ProcessInfo.processInfo.processIdentifier
        let items = WindowPicker.candidates(all)
        let helpers = items.filter { item in
            !item.window.isOnScreen && item.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard helpers.isEmpty else {
            throw Failure(message: "Picker offered \(helpers.count) hidden untitled windows as recording sources.")
        }
        let eligible = all.windows.filter {
            $0.windowLayer == 0 && $0.frame.width >= 160 && $0.frame.height >= 100
                && $0.owningApplication != nil && $0.owningApplication?.processID != pid
                && !($0.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        let offScreen = eligible.filter { !$0.isOnScreen }
        guard !offScreen.isEmpty else {
            throw Failure(message: "No off-screen fixture: open an app window on another desktop/Space and rerun.")
        }

        // Exercise both boundaries separately: broad content must reach the picker, and
        // the app's discovery request must include it in the first place.
        let pickerIDs = Set(items.map(\.id))
        let missingFromPicker = offScreen.filter { !pickerIDs.contains($0.windowID) }
        let discovered = try await ScreenCapture.shareableContent()
        let discoveredIDs = Set(discovered.windows.map(\.windowID))
        let missingFromDiscovery = offScreen.filter { !discoveredIDs.contains($0.windowID) }
        let excludedIDs = Set(all.windows.filter {
            $0.windowLayer != 0 || $0.frame.width < 160 || $0.frame.height < 100
                || $0.owningApplication == nil || $0.owningApplication?.processID == pid
        }.map(\.windowID))
        guard pickerIDs.isDisjoint(with: excludedIDs) else {
            throw Failure(message: "Picker included Reel, unowned, tiny, or nonstandard-layer windows.")
        }
        guard missingFromPicker.isEmpty && missingFromDiscovery.isEmpty else {
            throw Failure(message: "Off-screen windows missing: picker=\(missingFromPicker.count), discovery=\(missingFromDiscovery.count), eligible=\(offScreen.count).")
        }
        try await checkAccessoryWindow()
        try await checkFrameTimeout()
        try await checkResizedWindowCapture()
        print("Window picker smoke passed: \(offScreen.count) off-screen windows discovered and selectable; exclusions preserved.")
    }

    static func checkWindowActivation() async throws {
        let fixture = Process()
        fixture.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        fixture.arguments = ["--activation-fixture"]
        fixture.standardOutput = FileHandle.nullDevice
        try fixture.run()
        defer { if fixture.isRunning { fixture.terminate() } }
        let foreground = activationFixture(title: "Reel test foreground", color: .gray)
        foreground.makeKeyAndOrderFront(nil)
        NSApp.activate()
        defer { foreground.close() }

        let pid = fixture.processIdentifier
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            let content = try await ScreenCapture.shareableContent()
            let items = WindowPicker.candidates(content).filter { $0.window.owningApplication?.processID == pid }
            if let target = items.first(where: { $0.title == "Reel test blue target" }),
               let sibling = items.first(where: { $0.title == "Reel test red sibling" }) {
                guard target.window.frame == sibling.window.frame else {
                    throw Failure(message: "Focus fixture windows must overlap exactly (\(target.window.frame) and \(sibling.window.frame)).")
                }
                guard let frontBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier,
                      frontBefore != pid else {
                    NSApp.activate()
                    try await Task.sleep(for: .milliseconds(100))
                    continue
                }
                let cancelled = await WindowActivation.activate(target.window, stillRecording: { false })
                guard cancelled == .cancelled else { throw Failure(message: "Inactive recording attempted window focus.") }
                if AXIsProcessTrusted() {
                    let capture = ScreenCapture()
                    try await capture.start(target: .window(target.window), size: target.window.frame.size,
                                            fps: 10, showsCursor: false, showClicks: false, systemAudio: false)
                    let result = await WindowActivation.activate(target.window, stillRecording: { true })
                    let focused = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid &&
                        focusedWindowTitle(ownerPID: pid) == target.title
                    await capture.stop()
                    guard result == .activated, focused else {
                        throw Failure(message: "The exact selected window did not become frontmost (\(result)).")
                    }
                    print("Exact window focus during capture passed with an overlapping sibling.")
                } else {
                    let result = await WindowActivation.activate(target.window, stillRecording: { true })
                    guard result == .accessibilityRequired,
                          NSWorkspace.shared.frontmostApplication?.processIdentifier == frontBefore else {
                        throw Failure(message: "Missing Accessibility permission silently changed focus or failed to report it (\(result)).")
                    }
                    print("Accessibility fallback passed with foreground unchanged.")
                }
                return
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw Failure(message: "Generated window focus fixtures were not discoverable.")
    }

    static func focusedWindowTitle(ownerPID: pid_t) -> String? {
        let application = AXUIElementCreateApplication(ownerPID)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &focused) == .success,
              let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { return nil }
        var title: CFTypeRef?
        guard AXUIElementCopyAttributeValue(focused as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success else { return nil }
        return title as? String
    }

    static func checkAccessoryWindow() async throws {
        let fixture = Process()
        fixture.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        fixture.arguments = ["--accessory-fixture"]
        try fixture.run()
        defer { if fixture.isRunning { fixture.terminate() } }
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            let content = try await ScreenCapture.shareableContent()
            if let window = content.windows.first(where: {
                $0.owningApplication?.processID == fixture.processIdentifier && $0.title == "Reel accessory window fixture"
            }) {
                guard NSRunningApplication(processIdentifier: fixture.processIdentifier)?.activationPolicy == .accessory,
                      window.isOnScreen,
                      let item = WindowPicker.candidates(content).first(where: { $0.id == window.windowID }) else {
                    throw Failure(message: "Visible accessory-app window was excluded from the picker.")
                }
                try checkDesktopHitTesting(item, fixturePID: fixture.processIdentifier)
                return
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw Failure(message: "Accessory-app fixture window was not discoverable.")
    }

    static func checkDesktopHitTesting(_ item: WindowPicker.Item, fixturePID: pid_t) throws {
        guard let screen = NSScreen.screens.first else { throw Failure(message: "No fixture screen.") }
        let bounds = item.window.frame
        let frame = NSRect(x: bounds.minX, y: screen.frame.height - bounds.maxY,
                           width: bounds.width, height: bounds.height)
        let exposed = NSPoint(x: frame.midX + frame.width / 4, y: frame.midY)
        let blocked = NSPoint(x: frame.midX - frame.width / 4, y: frame.midY)
        let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                              kCGNullWindowID) as? [[String: Any]] ?? []
        // Verify the old bounds sweep would stop at the higher, non-candidate window.
        let quartzPoint = CGPoint(x: exposed.x, y: screen.frame.height - exposed.y)
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let covers = rows.filter { row in
            guard let pid = row[kCGWindowOwnerPID as String] as? pid_t, pid != ownPID,
                  (row[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                  let bounds = row[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
            return bounds.contains(quartzPoint)
        }
        let fixtureCover = covers.first { $0[kCGWindowOwnerPID as String] as? pid_t == fixturePID }
        guard let firstID = covers.first?[kCGWindowNumber as String] as? CGWindowID,
              let coverID = fixtureCover?[kCGWindowNumber as String] as? CGWindowID,
              firstID != item.id, coverID != item.id else {
            throw Failure(message: "Pass-through fixture did not mask the target in the old bounds sweep.")
        }

        let overlay = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                              backing: .buffered, defer: false)
        overlay.level = .screenSaver
        overlay.backgroundColor = NSColor.black.withAlphaComponent(0.24)
        overlay.orderFrontRegardless()
        defer { overlay.orderOut(nil) }
        let items = [item.id: item]
        guard WindowPicker.desktopItem(at: exposed, below: overlay.windowNumber, items: items)?.item.id == item.id else {
            throw Failure(message: "Desktop pointer did not select the exposed fixture window through its pass-through cover.")
        }
        guard WindowPicker.desktopItem(at: blocked, below: overlay.windowNumber, items: items) == nil else {
            throw Failure(message: "Desktop pointer selected a fixture window behind an interactive cover.")
        }
        print("Desktop hit testing selected fixture \(item.id) through pass-through window \(coverID) and rejected the blocked point.")
    }

    static func checkFrameTimeout() async throws {
        let empty = ScreenCapture()
        do {
            try await empty.waitForFirstFrame(timeout: 0.03)
            throw Failure(message: "A source without video frames was allowed to start recording.")
        } catch let error as NSError where error.domain == "Reel" && error.code == 22 {
            // A successful stream start must not hide a source that never supplies video.
        }
        let cancelled = Task { try await empty.waitForFirstFrame() }
        cancelled.cancel()
        do {
            try await cancelled.value
            throw Failure(message: "Cancelling capture preparation did not cancel its frame wait.")
        } catch is CancellationError { }
    }

    static func checkResizedWindowCapture() async throws {
        let fixture = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 480, height: 300),
                               styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        fixture.isReleasedWhenClosed = false
        fixture.animationBehavior = .none
        fixture.title = "Reel capture test — blue window"
        fixture.backgroundColor = NSColor(srgbRed: 0.1, green: 0.4, blue: 0.9, alpha: 1)
        fixture.makeKeyAndOrderFront(nil)
        defer { fixture.close() }
        let content = try await ScreenCapture.shareableContent()
        guard let stale = content.windows.first(where: { $0.windowID == CGWindowID(fixture.windowNumber) }) else {
            throw Failure(message: "Generated window capture fixture was not discoverable.")
        }
        fixture.setContentSize(NSSize(width: 720, height: 420))
        // Wait for WindowServer to finish the fixture's resize before testing a new lookup.
        let resizedBy = Date().addingTimeInterval(2)
        while Date() < resizedBy {
            let snapshot = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
            if let resized = snapshot.windows.first(where: { $0.windowID == stale.windowID }),
               resized.frame.width > stale.frame.width + 120,
               resized.frame.height > stale.frame.height + 60 { break }
            try await Task.sleep(for: .milliseconds(30))
        }
        let current = try await ScreenCapture.refreshedWindow(stale)
        // WindowServer may report inset or animated bounds rather than AppKit's exact frame.
        guard current.frame.width > stale.frame.width + 120,
              current.frame.height > stale.frame.height + 60 else {
            throw Failure(message: "Window selection retained stale bounds after resize: before=\(NSStringFromRect(stale.frame)), refreshed=\(NSStringFromRect(current.frame)), expected=\(NSStringFromRect(fixture.frame)).")
        }
        if CommandLine.arguments.contains("--show-picker") {
            let selected = await WindowPicker.pick(items: [WindowPicker.Item(id: current.windowID, window: current,
                app: "Reel capture test", title: fixture.title, icon: nil)])
            guard selected?.windowID == current.windowID else { throw Failure(message: "Generated picker fixture was not selected.") }
        }
        let capture = ScreenCapture()
        try await capture.start(target: .window(current), size: current.frame.size,
                                fps: 15, showsCursor: false, showClicks: false, systemAudio: false)
        let frame = capture.latestFrame
        await capture.stop()
        guard let frame else { throw Failure(message: "Window capture started without a video frame.") }
        CVPixelBufferLockBaseAddress(frame, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(frame, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(frame)?.assumingMemoryBound(to: UInt8.self) else {
            throw Failure(message: "Captured window frame had no pixels.")
        }
        var blue = 0, samples = 0
        for y in stride(from: 0, to: CVPixelBufferGetHeight(frame), by: 16) {
            for x in stride(from: 0, to: CVPixelBufferGetWidth(frame), by: 16) {
                let offset = y * CVPixelBufferGetBytesPerRow(frame) + x * 4
                if base[offset] > 150 && base[offset] > base[offset + 2] { blue += 1 }
                samples += 1
            }
        }
        guard blue * 10 > samples * 7 else {
            throw Failure(message: "Selected blue window was blank or captured the wrong content (\(blue)/\(samples) blue samples).")
        }
        try CIContext().writePNGRepresentation(of: CIImage(cvPixelBuffer: frame),
            to: URL(fileURLWithPath: "/tmp/reel-window-capture-smoke.png"), format: .RGBA8,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
        print("Resized window capture passed: \(CVPixelBufferGetWidth(frame))x\(CVPixelBufferGetHeight(frame)), \(blue)/\(samples) blue samples; empty-source timeout and cancellation passed.")
    }

    struct Failure: Error, CustomStringConvertible {
        let message: String
        var description: String { message }
    }
}
