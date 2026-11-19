import AppKit
import ReelCore
import ScreenCaptureKit
import SwiftUI

/// Lists real app windows, including titled windows on other Spaces, without exposing
/// hidden untitled helpers such as Chrome's background surfaces and AutoFill.
@MainActor
enum WindowPicker {
    private static var cancelActiveSelection: (() -> Void)?

    static func cancelSelection() { cancelActiveSelection?() }

    struct Item: Identifiable {
        let id: CGWindowID
        let window: SCWindow
        let app: String
        let title: String
        let icon: NSImage?
    }

    static func candidates(_ content: SCShareableContent) -> [Item] {
        let me = ProcessInfo.processInfo.processIdentifier
        let items: [Item] = content.windows.compactMap { w in
            guard w.windowLayer == 0, w.frame.width >= 160, w.frame.height >= 100,
                  let app = w.owningApplication, app.processID != me,
                  let running = NSRunningApplication(processIdentifier: app.processID) else { return nil }
            let title = (w.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            // A normal untitled window can be useful while visible. Hidden untitled
            // surfaces are commonly app helpers, not documents the user can identify.
            guard w.isOnScreen || !title.isEmpty else { return nil }
            let name = app.applicationName.isEmpty ? app.bundleIdentifier : app.applicationName
            return Item(id: w.windowID, window: w, app: name, title: title, icon: running.icon)
        }
        return items.sorted { lhs, rhs in
            if lhs.window.isOnScreen != rhs.window.isOnScreen { return lhs.window.isOnScreen }
            let appOrder = lhs.app.localizedStandardCompare(rhs.app)
            if appOrder != .orderedSame { return appOrder == .orderedAscending }
            let titleOrder = lhs.title.localizedStandardCompare(rhs.title)
            if titleOrder != .orderedSame { return titleOrder == .orderedAscending }
            return lhs.id < rhs.id
        }
    }

    static func pick(from content: SCShareableContent) async -> SCWindow? {
        await pick(items: candidates(content))
    }

    /// Use the same SCWindow identifiers as capture on every supported macOS version.
    /// CoreGraphics supplies front-to-back ordering for the visible portion of each window.
    static func pickOnDesktop(items: [Item]) async -> SCWindow? {
        let visible = items.filter { $0.window.isOnScreen }
        guard !visible.isEmpty, !NSScreen.screens.isEmpty, cancelActiveSelection == nil else { return nil }
        return await withCheckedContinuation { continuation in
            var panels: [NSPanel] = []
            var finished = false
            let finish: (SCWindow?) -> Void = { window in
                guard !finished else { return }
                finished = true
                cancelActiveSelection = nil
                panels.forEach { $0.orderOut(nil) }
                panels.removeAll()
                continuation.resume(returning: window)
            }
            cancelActiveSelection = { finish(nil) }
            for screen in NSScreen.screens {
                let panel = WindowSelectionPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                                                 backing: .buffered, defer: false)
                panel.isOpaque = false
                panel.backgroundColor = .clear
                panel.level = .screenSaver
                panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
                panel.hidesOnDeactivate = false
                panel.acceptsMouseMovedEvents = true
                panel.contentView = DesktopPickerView(screen: screen, items: visible, finish: finish)
                panel.setFrame(screen.frame, display: false)
                panels.append(panel)
                panel.orderFrontRegardless()
            }
            let keyPanel = panels.first { $0.frame.contains(NSEvent.mouseLocation) } ?? panels.first
            keyPanel?.makeKey()
            keyPanel?.makeFirstResponder(keyPanel?.contentView)
        }
    }

    static func pick(items: [Item]) async -> SCWindow? {
        guard !items.isEmpty, cancelActiveSelection == nil else { return nil }
        return await withCheckedContinuation { (c: CheckedContinuation<SCWindow?, Never>) in
            let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 500), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            panel.title = "Choose a window to record"
            panel.isReleasedWhenClosed = false
            panel.level = .floating
            var finished = false
            let finish: (SCWindow?) -> Void = { w in
                guard !finished else { return }
                finished = true
                cancelActiveSelection = nil
                panel.close()
                c.resume(returning: w)
            }
            cancelActiveSelection = { finish(nil) }
            panel.contentView = NSHostingView(rootView: PickerView(items: items, choose: finish))
            let delegate = PanelCloseDelegate { finish(nil) }
            panel.delegate = delegate
            objc_setAssociatedObject(panel, "delegate", delegate, .OBJC_ASSOCIATION_RETAIN)
            panel.center()
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        }
    }

    private struct PickerView: View {
        let items: [Item]
        let choose: (SCWindow?) -> Void
        @State private var query = ""
        @State private var selectedID: CGWindowID?
        @FocusState private var searching: Bool

        private var matches: [Item] {
            let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
            return items.filter { term.isEmpty || $0.title.localizedStandardContains(term) || $0.app.localizedStandardContains(term) }
        }

        private var selected: SCWindow? {
            matches.first { $0.id == selectedID }?.window ?? (matches.count == 1 ? matches.first?.window : nil)
        }

        var body: some View {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("Search windows by title or app", text: $query)
                        .textFieldStyle(.roundedBorder)
                        .focused($searching)
                        .onSubmit { if let selected { choose(selected) } }
                    Text("Reel records the whole window, including any tabs you switch to.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                .padding(12)
                List(selection: $selectedID) {
                    windowSection("On this desktop", for: matches.filter { $0.window.isOnScreen })
                    windowSection("Other windows", for: matches.filter { !$0.window.isOnScreen })
                }
                .overlay {
                    if matches.isEmpty {
                        ContentUnavailableView.search(text: query)
                    }
                }
                HStack {
                    Spacer()
                    Button("Cancel") { choose(nil) }.keyboardShortcut(.cancelAction)
                    Button("Choose window") { if let selected { choose(selected) } }
                        .keyboardShortcut(.defaultAction)
                        .disabled(selected == nil)
                }
                .padding(12)
            }
            .task { searching = true }
        }

        @ViewBuilder
        private func windowSection(_ title: String, for items: [Item]) -> some View {
            if !items.isEmpty {
                Section(title) {
                    ForEach(items) { item in
                        Button { choose(item.window) } label: { WindowRow(item: item) }
                            .buttonStyle(.plain)
                            .padding(.vertical, 4)
                            .tag(item.id)
                    }
                }
            }
        }
    }

    private struct WindowRow: View {
        let item: Item
        @State private var preview: NSImage?

        var body: some View {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 6).fill(.quaternary)
                    if let preview {
                        Image(nsImage: preview).resizable().scaledToFit()
                    } else if let icon = item.icon {
                        Image(nsImage: icon).resizable().scaledToFit().padding(12)
                    }
                }
                .frame(width: 96, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title.isEmpty ? "Untitled window" : item.title)
                        .font(.headline).lineLimit(2)
                    Text(item.app).font(.caption).foregroundStyle(.secondary)
                    Text("\(Int(item.window.frame.width))×\(Int(item.window.frame.height))\(item.window.isOnScreen ? "" : " · Not on current desktop")")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .task(id: item.id) {
                let config = SCStreamConfiguration()
                config.width = 192
                config.height = 120
                config.showsCursor = false
                config.scalesToFit = true
                config.preservesAspectRatio = true
                guard let image = try? await SCScreenshotManager.captureImage(
                    contentFilter: SCContentFilter(desktopIndependentWindow: item.window), configuration: config),
                    !Task.isCancelled else { return }
                preview = NSImage(cgImage: image, size: .zero)
            }
        }
    }
}

private final class WindowSelectionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

@MainActor
private final class DesktopPickerView: NSView {
    private let screen: NSScreen
    private let items: [CGWindowID: WindowPicker.Item]
    private let finish: (SCWindow?) -> Void
    private var target: (WindowPicker.Item, NSRect)?
    private var tracking: NSTrackingArea?
    private var lastUpdate = 0.0

    init(screen: NSScreen, items: [WindowPicker.Item], finish: @escaping (SCWindow?) -> Void) {
        self.screen = screen
        self.items = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        self.finish = finish
        super.init(frame: NSRect(origin: .zero, size: screen.frame.size))
    }

    required init?(coder: NSCoder) { fatalError() }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.inVisibleRect, .activeAlways, .mouseEnteredAndExited, .mouseMoved],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { updateTarget() }
    override func mouseMoved(with event: NSEvent) {
        let now = ProcessInfo.processInfo.systemUptime
        if now - lastUpdate >= 1.0 / 45 { updateTarget() }
    }
    override func mouseExited(with event: NSEvent) { target = nil; needsDisplay = true }
    override func mouseDown(with event: NSEvent) {
        updateTarget()
        if let target { finish(target.0.window) }
    }
    override func cancelOperation(_ sender: Any?) { finish(nil) }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { cancelOperation(nil) } else { super.keyDown(with: event) }
    }

    private func updateTarget() {
        lastUpdate = ProcessInfo.processInfo.systemUptime
        let point = NSEvent.mouseLocation
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                  kCGNullWindowID) as? [[String: Any]] ?? []
        target = nil
        for row in windows {
            guard let id = row[kCGWindowNumber as String] as? CGWindowID,
                  let pid = row[kCGWindowOwnerPID as String] as? pid_t, pid != ownPID,
                  (row[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                  let rawBounds = row[kCGWindowBounds as String] as? [String: Any],
                  let cgFrame = CGRect(dictionaryRepresentation: rawBounds as CFDictionary) else { continue }
            let frame = VideoGeometry.appKitRect(fromCG: Rect(cgFrame), primaryHeight: primaryHeight).cg
            guard frame.contains(point) else { continue }
            if let item = items[id], item.window.owningApplication?.processID == pid {
                target = (item, frame.offsetBy(dx: -screen.frame.minX, dy: -screen.frame.minY))
            }
            break // Never select a window under a different window that occupies this point.
        }
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.24).setFill()
        bounds.fill()
        if let (_, frame) = target {
            NSGraphicsContext.current?.compositingOperation = .clear
            frame.fill()
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            NSColor.systemMint.setStroke()
            let outline = NSBezierPath(roundedRect: frame.insetBy(dx: 2, dy: 2), xRadius: 8, yRadius: 8)
            outline.lineWidth = 4
            outline.stroke()
        }
        let label = (target.map { "Select \($0.0.app)  ·  Esc to cancel" } ?? "Point to a window to select it  ·  Esc to cancel") as NSString
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 15, weight: .semibold), .foregroundColor: NSColor.white]
        let size = label.size(withAttributes: attrs)
        let badge = NSRect(x: bounds.midX - size.width / 2 - 16, y: bounds.maxY - size.height - 60,
                           width: size.width + 32, height: size.height + 18)
        NSColor.black.withAlphaComponent(0.85).setFill()
        NSBezierPath(roundedRect: badge, xRadius: 8, yRadius: 8).fill()
        label.draw(at: NSPoint(x: badge.minX + 16, y: badge.minY + 9), withAttributes: attrs)
    }
}

final class PanelCloseDelegate: NSObject, NSWindowDelegate {
    let onClose: () -> Void
    init(onClose: @escaping () -> Void) { self.onClose = onClose }
    func windowWillClose(_ notification: Notification) { onClose() }
}
