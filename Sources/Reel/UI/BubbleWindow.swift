import AppKit
import AVFoundation

/// Circular, draggable camera preview. It is an ordinary on-screen window that ScreenCaptureKit
/// is told to exclude; the recording gets the same camera frames composited at the same spot.
final class BubbleWindow: NSPanel {
    var onMove: ((CGRect?) -> Void)?
    private let preview: AVCaptureVideoPreviewLayer
    private let bubbleView = BubbleView()
    /// Shows effect-processed frames (background blur / virtual background) over the preview.
    private let effectLayer = CALayer()

    init(session: AVCaptureSession) {
        preview = AVCaptureVideoPreviewLayer(session: session)
        super.init(contentRect: NSRect(x: 0, y: 0, width: 220, height: 220), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        preview.videoGravity = .resizeAspectFill
        if let c = preview.connection, c.isVideoMirroringSupported {
            c.automaticallyAdjustsVideoMirroring = false
            c.isVideoMirrored = true
        }
        bubbleView.wantsLayer = true
        bubbleView.layer?.addSublayer(preview)
        effectLayer.contentsGravity = .resizeAspectFill
        effectLayer.isHidden = true
        effectLayer.setAffineTransform(CGAffineTransform(scaleX: -1, y: 1))   // mirrored like the preview
        bubbleView.layer?.addSublayer(effectLayer)
        bubbleView.layer?.masksToBounds = true
        bubbleView.layer?.borderWidth = 0
        bubbleView.onDrag = { [weak self] delta in
            guard let self else { return }
            var origin = self.frame.origin
            origin.x += delta.x
            origin.y += delta.y
            self.setFrameOrigin(origin)
            self.onMove?(self.frame)
        }
        contentView = bubbleView
    }

    func present(diameter: Double, on screen: NSScreen) {
        let d = CGFloat(diameter)
        var frame = self.frame
        if !isVisible || !screen.frame.intersects(frame) {
            let v = screen.visibleFrame
            frame = NSRect(x: v.minX + 32, y: v.minY + 32, width: d, height: d)
        } else {
            frame.size = NSSize(width: d, height: d)
        }
        setFrame(frame, display: true)
        bubbleView.layer?.cornerRadius = d / 2
        preview.frame = bubbleView.bounds
        orderFrontRegardless()
        onMove?(self.frame)
    }

    /// Moves the bubble to `rect` (AppKit global coordinates), e.g. into a selected area or onto
    /// the display being recorded.
    func place(_ rect: CGRect) {
        setFrame(rect, display: true)
        bubbleView.layer?.cornerRadius = rect.width / 2
        onMove?(frame)
    }

    /// Main thread. nil hides the effect layer (raw preview).
    func showProcessed(_ buffer: CVPixelBuffer?) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let buffer, let surface = CVPixelBufferGetIOSurface(buffer)?.takeUnretainedValue() {
            effectLayer.contents = surface
            effectLayer.isHidden = false
        } else {
            effectLayer.contents = nil
            effectLayer.isHidden = true
        }
        CATransaction.commit()
    }

    override var canBecomeKey: Bool { false }
}

private final class BubbleView: NSView {
    var onDrag: ((CGPoint) -> Void)?
    private var last: NSPoint?
    override var mouseDownCanMoveWindow: Bool { false }
    override func mouseDown(with event: NSEvent) { last = NSEvent.mouseLocation }
    override func mouseDragged(with event: NSEvent) {
        let now = NSEvent.mouseLocation
        if let last { onDrag?(CGPoint(x: now.x - last.x, y: now.y - last.y)) }
        last = now
    }
    override func mouseUp(with event: NSEvent) { last = nil }
    override func layout() {
        super.layout()
        layer?.sublayers?.forEach { $0.frame = bounds }
    }
}
