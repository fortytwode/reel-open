import AppKit
import ReelCore

/// Transparent full-display window for drawing over the screen while recording. Like all of
/// Reel's windows it is excluded from capture; the strokes reach the recording through the
/// compositor (same vector data, mapped to output pixels). When drawing is off the window
/// ignores the mouse entirely, so clicks go to the apps underneath.
@MainActor
final class DrawingOverlay: NSPanel {
    private let canvas: CanvasView
    let store: OverlayStore

    init(screen: NSScreen, store: OverlayStore) {
        self.store = store
        canvas = CanvasView(store: store)
        super.init(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        // Above normal windows, below the bubble and control bar (.floating) so they stay usable.
        level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue - 1)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        ignoresMouseEvents = true
        setFrame(screen.frame, display: false)
        canvas.frame = NSRect(origin: .zero, size: screen.frame.size)
        contentView = canvas
    }

    override var canBecomeKey: Bool { !ignoresMouseEvents }

    func move(to screen: NSScreen) { setFrame(screen.frame, display: true) }

    /// Syncs mouse handling and redraws from the shared state.
    func refresh() {
        let state = store.drawingState
        ignoresMouseEvents = state.overlayIgnoresMouse
        if state.isActive {
            orderFrontRegardless()
            NSCursor.crosshair.set()
        } else if state.visibleStrokes.isEmpty {
            orderOut(nil)
        } else {
            orderFrontRegardless()
        }
        canvas.needsDisplay = true
        invalidateCursorRects(for: canvas)
    }
}

private final class CanvasView: NSView {
    let store: OverlayStore
    init(store: OverlayStore) {
        self.store = store
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() {
        if store.drawingState.isActive { addCursorRect(bounds, cursor: .crosshair) }
    }

    private func global(_ event: NSEvent) -> Point {
        let p = NSEvent.mouseLocation
        return Point(x: p.x, y: p.y)
    }

    override func mouseDown(with event: NSEvent) {
        store.updateDrawing { $0.begin(at: global(event)) }
        needsDisplay = true
    }
    override func mouseDragged(with event: NSEvent) {
        store.updateDrawing { $0.extend(to: global(event)) }
        needsDisplay = true
    }
    override func mouseUp(with event: NSEvent) {
        store.updateDrawing { $0.end() }
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext, let window else { return }
        let origin = window.frame.origin
        let state = store.drawingState
        if state.isActive {
            // A faint tint shows that drawing mode is on (not recorded: this window is excluded).
            NSColor(red: 0.91, green: 0.33, blue: 0.24, alpha: 0.04).setFill()
            bounds.fill()
            let border = NSBezierPath(rect: bounds.insetBy(dx: 2, dy: 2))
            border.lineWidth = 4
            NSColor(red: 0.91, green: 0.33, blue: 0.24, alpha: 0.6).setStroke()
            border.stroke()
        }
        for stroke in state.visibleStrokes {
            OverlayRenderer.draw(stroke, in: ctx, scale: 1) { CGPoint(x: $0.x - origin.x, y: $0.y - origin.y) }
        }
    }
}

/// Mouse-down monitor for click highlights. Global monitors see clicks in other apps only, so
/// clicks on Reel's own windows (control bar, bubble, drawing) are never highlighted, as Loom
/// ignores clicks on its own windows. Mouse monitors need no Accessibility permission.
@MainActor
final class ClickMonitor {
    private var monitor: Any?
    func start(store: OverlayStore) {
        stop()
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { _ in
            let p = NSEvent.mouseLocation
            store.addClick(ClickEvent(x: p.x, y: p.y, time: RecordingSession.now()))
        }
        if monitor == nil { Log.capture.error("Global mouse monitor was not installed") }
    }
    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }
}
