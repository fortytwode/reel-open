import AppKit
import ReelCore
import ScreenCaptureKit
import SwiftUI

/// Lists real app windows, including titled windows on other Spaces, without exposing
/// hidden untitled helpers such as Chrome's background surfaces and AutoFill.
@MainActor
enum WindowPicker {
    private static var cancelActiveSelection: (() -> Void)?
    private static var browseActiveSelection: (() -> Void)?

    static func cancelSelection() { cancelActiveSelection?() }
    static func browseWindows() -> Bool {
        guard let browseActiveSelection else { return false }
        browseActiveSelection()
        return true
    }

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

    static func desktopItem(at point: NSPoint, below overlayWindowNumber: Int,
                            items: [CGWindowID: Item], excluding toolbar: NSWindow? = nil) -> (item: Item, frame: NSRect)? {
        // The toolbar sits above the dimmer, so a search below the dimmer skips it.
        // Use the live frame so moved or resized controls never expose a target through the toolbar.
        if let toolbar, toolbar.isVisible, toolbar.frame.contains(point) { return nil }
        // AppKit uses actual mouse hit-testing, so a click-through panel or a
        // transparent part of another window cannot hide the window underneath.
        let number = NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: overlayWindowNumber)
        guard let id = CGWindowID(exactly: number), let item = items[id],
              let row = (CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]])?.first,
              row[kCGWindowOwnerPID as String] as? pid_t == item.window.owningApplication?.processID,
              let rawBounds = row[kCGWindowBounds as String] as? [String: Any],
              let cgFrame = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
              let primary = NSScreen.screens.first else { return nil }
        let frame = VideoGeometry.appKitRect(
            fromCG: Rect(x: cgFrame.minX, y: cgFrame.minY, width: cgFrame.width, height: cgFrame.height),
            primaryHeight: primary.frame.height)
        return (item, NSRect(x: frame.x, y: frame.y, width: frame.width, height: frame.height))
    }

    private enum DesktopChoice {
        case selected(SCWindow), browse, cancelled
    }

    static func pickOnDesktop(items: [Item], keepingAbove toolbar: NSWindow? = nil) async -> SCWindow? {
        let visible = items.filter { $0.window.isOnScreen }
        guard cancelActiveSelection == nil, !Task.isCancelled else { return nil }
        guard !visible.isEmpty, !NSScreen.screens.isEmpty else { return await pick(items: items) }
        return await withCheckedContinuation { continuation in
            // Keep both picker layers below native menus, including the toolbar's options menu.
            let overlayLevel = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
            let originalToolbarLevel = toolbar?.level
            var panels: [NSPanel] = []
            var keyMonitor: Any?
            var finished = false
            let finish: (DesktopChoice) -> Void = { choice in
                guard !finished else { return }
                finished = true
                cancelActiveSelection = nil
                browseActiveSelection = nil
                if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
                keyMonitor = nil
                panels.forEach { $0.orderOut(nil) }
                panels.removeAll()
                if let originalToolbarLevel { toolbar?.level = originalToolbarLevel }
                switch choice {
                case .selected(let window): continuation.resume(returning: window)
                case .cancelled: continuation.resume(returning: nil)
                case .browse: presentList(items: items) { continuation.resume(returning: $0) }
                }
            }
            cancelActiveSelection = { finish(.cancelled) }
            browseActiveSelection = { finish(.browse) }
            if let toolbar {
                toolbar.level = NSWindow.Level(rawValue: overlayLevel.rawValue + 1)
                keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                    guard event.window === toolbar else { return event }
                    if event.keyCode == 53 {
                        finish(.cancelled)
                        return nil
                    }
                    if [36, 76].contains(event.keyCode),
                       let panel = panels.first(where: { $0.frame.contains(NSEvent.mouseLocation) }),
                       let picker = panel.contentView as? DesktopPickerView,
                       picker.selectWindowUnderPointer() { return nil }
                    return event
                }
            }
            for screen in NSScreen.screens {
                let panel = WindowSelectionPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                                                 backing: .buffered, defer: false)
                panel.appearance = NSAppearance(named: .darkAqua)
                panel.isOpaque = false
                panel.backgroundColor = .clear
                panel.level = overlayLevel
                panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
                panel.hidesOnDeactivate = false
                panel.becomesKeyOnlyIfNeeded = toolbar != nil
                panel.acceptsMouseMovedEvents = true
                panel.contentView = DesktopPickerView(screen: screen, items: visible, toolbar: toolbar,
                    select: { finish(.selected($0)) }, browse: { finish(.browse) }, cancel: { finish(.cancelled) })
                panel.setFrame(screen.frame, display: false)
                panels.append(panel)
                panel.orderFrontRegardless()
            }
            let keyPanel = panels.first { $0.frame.contains(NSEvent.mouseLocation) } ?? panels.first
            if toolbar == nil {
                keyPanel?.makeKey()
                keyPanel?.makeFirstResponder(keyPanel?.contentView)
            }
            (keyPanel?.contentView as? DesktopPickerView)?.refreshTarget()
        }
    }

    static func pick(items: [Item]) async -> SCWindow? {
        guard !items.isEmpty, cancelActiveSelection == nil, !Task.isCancelled else { return nil }
        return await withCheckedContinuation { continuation in
            presentList(items: items) { continuation.resume(returning: $0) }
        }
    }

    private static func presentList(items: [Item], choose: @escaping (SCWindow?) -> Void) {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 500), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "Choose a window to record"
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        var finished = false
        let finish: (SCWindow?) -> Void = { [weak panel] window in
            guard !finished else { return }
            finished = true
            cancelActiveSelection = nil
            panel?.delegate = nil
            panel?.close()
            choose(window)
        }
        cancelActiveSelection = { [panel] in panel.close() }
        panel.contentView = NSHostingView(rootView: PickerView(items: items, choose: finish))
        let delegate = PanelCloseDelegate { finish(nil) }
        panel.delegate = delegate
        objc_setAssociatedObject(panel, "delegate", delegate, .OBJC_ASSOCIATION_RETAIN)
        panel.center()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
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
    private weak var toolbar: NSWindow?
    private let items: [CGWindowID: WindowPicker.Item]
    private let select: (SCWindow) -> Void
    private let browse: () -> Void
    private let cancel: () -> Void
    private let selectButton = NSButton(title: "Select window", target: nil, action: nil)
    private let controls = NSStackView()
    private var target: (item: WindowPicker.Item, frame: NSRect)?
    private var tracking: NSTrackingArea?
    private var lastHoverCheck = 0.0

    init(screen: NSScreen, items: [WindowPicker.Item], toolbar: NSWindow?, select: @escaping (SCWindow) -> Void,
         browse: @escaping () -> Void, cancel: @escaping () -> Void) {
        self.screen = screen
        self.toolbar = toolbar
        self.items = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        self.select = select
        self.browse = browse
        self.cancel = cancel
        super.init(frame: NSRect(origin: .zero, size: screen.frame.size))

        selectButton.target = self
        selectButton.action = #selector(confirmTarget)
        selectButton.bezelStyle = .rounded
        selectButton.controlSize = .large
        selectButton.bezelColor = .systemTeal
        selectButton.isHidden = true
        addSubview(selectButton)

        controls.addArrangedSubview(NSButton(title: "Browse windows…", target: self, action: #selector(showList)))
        controls.addArrangedSubview(NSButton(title: "Cancel", target: self, action: #selector(cancelSelection)))
        controls.translatesAutoresizingMaskIntoConstraints = false
        controls.spacing = 8
        addSubview(controls)
        NSLayoutConstraint.activate([
            controls.centerXAnchor.constraint(equalTo: centerXAnchor),
            controls.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -30)
        ])
        if let toolbar {
            NotificationCenter.default.addObserver(self, selector: #selector(updateControls),
                name: NSWindow.didChangeScreenNotification, object: toolbar)
            updateControls()
        }
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

    override func mouseEntered(with event: NSEvent) {
        if toolbar == nil, let window, !window.isKeyWindow {
            window.makeKey()
            window.makeFirstResponder(self)
        }
        refreshTarget()
    }
    override func mouseMoved(with event: NSEvent) {
        guard let window, event.timestamp - lastHoverCheck >= 1 / 60 else { return }
        lastHoverCheck = event.timestamp
        refreshTarget(at: window.convertPoint(toScreen: event.locationInWindow))
    }
    override func mouseExited(with event: NSEvent) { showTarget(nil) }
    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        _ = selectWindow(at: window.convertPoint(toScreen: event.locationInWindow))
    }
    override func cancelOperation(_ sender: Any?) { cancel() }
    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 53: cancel()
        case 36, 76: _ = selectWindowUnderPointer()
        default: super.keyDown(with: event)
        }
    }

    func selectWindowUnderPointer() -> Bool {
        selectWindow(at: NSEvent.mouseLocation)
    }

    private func selectWindow(at point: NSPoint) -> Bool {
        refreshTarget(at: point)
        guard let target else { return false }
        select(target.item.window)
        return true
    }

    @objc private func showList() { browse() }
    @objc private func cancelSelection() { cancel() }
    @objc private func confirmTarget() { _ = selectWindowUnderPointer() }
    @objc private func updateControls(_ notification: Notification? = nil) {
        controls.isHidden = toolbar?.screen?.frame == screen.frame
    }

    func refreshTarget(at point: NSPoint = NSEvent.mouseLocation) {
        guard let window, screen.frame.contains(point),
              let hit = WindowPicker.desktopItem(at: point, below: window.windowNumber, items: items, excluding: toolbar) else {
            showTarget(nil)
            return
        }
        showTarget((hit.item, hit.frame.offsetBy(dx: -screen.frame.minX, dy: -screen.frame.minY)))
    }

    private func showTarget(_ newValue: (item: WindowPicker.Item, frame: NSRect)?) {
        guard target?.item.id != newValue?.item.id || target?.frame != newValue?.frame else { return }
        target = newValue
        selectButton.isHidden = newValue == nil
        if let (item, frame) = newValue {
            let available = frame.intersection(bounds)
            selectButton.title = "Select \(item.app)"
            selectButton.toolTip = item.title.isEmpty ? nil : item.title
            selectButton.sizeToFit()
            selectButton.setFrameOrigin(NSPoint(x: available.midX - selectButton.frame.width / 2,
                                                 y: available.midY - selectButton.frame.height / 2))
        }
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.24).setFill()
        bounds.fill(using: .copy)
        if let (_, frame) = target {
            // Keep the highlighted interior clickable. Fully transparent pixels
            // send the mouse-down to the underlying application instead.
            NSColor.systemMint.withAlphaComponent(0.08).setFill()
            frame.fill(using: .copy)
            NSColor.systemMint.setStroke()
            let outline = NSBezierPath(roundedRect: frame.insetBy(dx: 2, dy: 2), xRadius: 8, yRadius: 8)
            outline.lineWidth = 4
            outline.stroke()
        }
        let label = "Click a window to select it  ·  Esc to cancel" as NSString
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
