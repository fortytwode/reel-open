import AppKit

/// Area mode: a dimmed overlay on every display; drag a rectangle to record just that part of
/// the screen (Loom's AreaSelection*). Return reuses the previous area, Esc cancels. Returns the
/// selection in AppKit global coordinates and the screen it is on.
@MainActor
enum AreaSelector {
    static func select(previous: CGRect?) async -> (screen: NSScreen, rect: CGRect)? {
        await withCheckedContinuation { (c: CheckedContinuation<(screen: NSScreen, rect: CGRect)?, Never>) in
            var windows: [AreaWindow] = []
            var finished = false
            let finish: ((NSScreen, CGRect)?) -> Void = { result in
                guard !finished else { return }
                finished = true
                windows.forEach { $0.orderOut(nil) }
                windows.removeAll()
                NSCursor.arrow.set()
                c.resume(returning: result.map { (screen: $0.0, rect: $0.1) })
            }
            for screen in NSScreen.screens {
                let w = AreaWindow(screen: screen, previous: previous, finish: finish)
                windows.append(w)
                w.orderFrontRegardless()
            }
            NSApp.activate(ignoringOtherApps: true)
            let mouse = NSEvent.mouseLocation
            (windows.first { NSMouseInRect(mouse, $0.frame, false) } ?? windows.first)?.makeKey()
        }
    }
}

private final class AreaWindow: NSPanel {
    init(screen: NSScreen, previous: CGRect?, finish: @escaping ((NSScreen, CGRect)?) -> Void) {
        super.init(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        level = .screenSaver
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        acceptsMouseMovedEvents = true
        setFrame(screen.frame, display: false)
        contentView = AreaView(screen: screen, previous: previous, finish: finish)
    }
    override var canBecomeKey: Bool { true }
}

private final class AreaView: NSView {
    let screen: NSScreen
    let previous: CGRect?
    let finish: ((NSScreen, CGRect)?) -> Void
    private var start: NSPoint?
    private var current: NSRect?

    init(screen: NSScreen, previous: CGRect?, finish: @escaping ((NSScreen, CGRect)?) -> Void) {
        self.screen = screen
        self.previous = previous
        self.finish = finish
        super.init(frame: NSRect(origin: .zero, size: screen.frame.size))
    }
    required init?(coder: NSCoder) { fatalError() }

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }

    override func mouseDown(with event: NSEvent) {
        start = convert(event.locationInWindow, from: nil)
        current = nil
    }
    override func mouseDragged(with event: NSEvent) {
        guard let start else { return }
        let p = convert(event.locationInWindow, from: nil)
        current = NSRect(x: min(start.x, p.x), y: min(start.y, p.y), width: abs(p.x - start.x), height: abs(p.y - start.y))
        needsDisplay = true
    }
    override func mouseUp(with event: NSEvent) {
        defer { start = nil }
        guard let r = current, r.width >= 32, r.height >= 32 else { current = nil; needsDisplay = true; return }
        finish((screen, r.offsetBy(dx: screen.frame.minX, dy: screen.frame.minY)))
    }
    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 53: finish(nil)                                                    // Esc
        case 36, 76:                                                            // Return / Enter
            if let p = previous, let s = NSScreen.screens.first(where: { $0.frame.intersects(p) }) { finish((s, p)) }
        default: super.keyDown(with: event)
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.35).setFill()
        bounds.fill()
        if let r = current {
            NSGraphicsContext.current?.compositingOperation = .clear
            r.fill()
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            let border = NSBezierPath(rect: r.insetBy(dx: -1, dy: -1))
            border.lineWidth = 2
            NSColor(red: 0.91, green: 0.33, blue: 0.24, alpha: 1).setStroke()
            border.stroke()
            let label = "\(Int(r.width)) × \(Int(r.height))" as NSString
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold), .foregroundColor: NSColor.white]
            let size = label.size(withAttributes: attrs)
            let box = NSRect(x: r.maxX - size.width - 12, y: max(4, r.minY - size.height - 10), width: size.width + 10, height: size.height + 4)
            NSColor.black.withAlphaComponent(0.75).setFill()
            NSBezierPath(roundedRect: box, xRadius: 4, yRadius: 4).fill()
            label.draw(at: NSPoint(x: box.minX + 5, y: box.minY + 2), withAttributes: attrs)
        } else {
            let hint = "Drag to select the area to record · \(previous == nil ? "" : "Return: previous area · ")Esc: cancel" as NSString
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 15, weight: .medium), .foregroundColor: NSColor.white]
            let size = hint.size(withAttributes: attrs)
            let box = NSRect(x: bounds.midX - size.width / 2 - 14, y: bounds.midY - size.height / 2 - 8, width: size.width + 28, height: size.height + 16)
            NSColor.black.withAlphaComponent(0.7).setFill()
            NSBezierPath(roundedRect: box, xRadius: 10, yRadius: 10).fill()
            hint.draw(at: NSPoint(x: box.minX + 14, y: box.minY + 8), withAttributes: attrs)
            if let p = previous, screen.frame.intersects(p) {
                let local = p.offsetBy(dx: -screen.frame.minX, dy: -screen.frame.minY)
                let dash = NSBezierPath(rect: local)
                dash.setLineDash([6, 4], count: 2, phase: 0)
                dash.lineWidth = 1.5
                NSColor.white.withAlphaComponent(0.8).setStroke()
                dash.stroke()
            }
        }
    }
}
