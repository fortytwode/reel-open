import AppKit
import CoreImage
import ScreenCaptureKit

// Requires Screen Recording access and a normal app window on another desktop/Space.
// Run from the repository root:
// swiftc -parse-as-library Sources/Reel/Log.swift Sources/Reel/Capture/ScreenCapture.swift \
//   Sources/Reel/UI/WindowPicker.swift scripts/tests/WindowPickerSmoke.swift -o /tmp/reel-window-picker-smoke
// /tmp/reel-window-picker-smoke
// Add --show-picker to inspect the production picker with a generated, non-private fixture.
@main @MainActor
struct WindowPickerSmoke {
    static func main() {
        let app = NSApplication.shared
        if CommandLine.arguments.contains("--accessory-fixture") {
            app.setActivationPolicy(.accessory)
            let window = NSWindow(contentRect: NSRect(x: 160, y: 160, width: 480, height: 300),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Reel accessory window fixture"
            window.isReleasedWhenClosed = false
            window.orderFrontRegardless()
            app.run()
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

    static func run() async throws {
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
                      WindowPicker.candidates(content).contains(where: { $0.id == window.windowID }) else {
                    throw Failure(message: "Visible accessory-app window was excluded from the picker.")
                }
                print("Visible accessory-app window remained selectable.")
                return
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw Failure(message: "Accessory-app fixture window was not discoverable.")
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
