import AppKit
import AVFoundation
import ReelCore
import ScreenCaptureKit

struct RecordingRequest {
    var mode: CaptureMode
    var display: SCDisplay?
    var window: SCWindow?
    /// Area mode: the selection in AppKit global coordinates (on `display`).
    var area: CGRect?
    var content: SCShareableContent?
    var camera: CameraCapture?          // running camera (bubble or camera-only source)
    var microphone: AVCaptureDevice?
    var audio: AudioSource
    var quality: QualityPreset
    var fps: Int
    var showsCursor: Bool
    var showClicks: Bool
}

struct RecordingResult {
    var segmentsDirectory: URL
    var log: SegmentLog
    var duration: Double
    var size: PixelSize
}

/// Annotations and clicks shared between the UI (main thread) and the render queue.
final class OverlayStore: @unchecked Sendable {
    private let lock = NSLock()
    private var drawing = DrawingState()
    private var clicks: [ClickEvent] = []

    var drawingState: DrawingState { lock.withLock { drawing } }
    func updateDrawing(_ change: (inout DrawingState) -> Void) { lock.withLock { change(&drawing) } }

    func addClick(_ c: ClickEvent) { lock.withLock { clicks.append(c); if clicks.count > 32 { clicks.removeFirst(clicks.count - 32) } } }
    func activeClicks(now: Double) -> [ClickEvent] {
        lock.withLock {
            clicks.removeAll { now - $0.time > ClickRipple.duration }
            return clicks
        }
    }
    func reset() { lock.withLock { drawing = DrawingState(); clicks = [] } }
}

/// One recording. Capture streams are started in `prepare()` (during the countdown) and the
/// timeline starts at `begin()`. A fixed-rate frame clock composites the latest screen frame,
/// annotations, click ripples and the latest camera frame, so the output has a constant frame
/// rate even when the screen is static (SCStream only delivers frames on change). Audio from
/// the mic and system is mixed in real time into one track. Output goes to `SegmentedWriter`.
final class RecordingSession: @unchecked Sendable {
    let request: RecordingRequest
    let segmentsDirectory: URL
    let overlays: OverlayStore
    private let screen = ScreenCapture()
    private var mic: MicCapture?
    private(set) var writer: SegmentedWriter!
    private let compositor = Compositor()
    private let overlayRenderer = OverlayRenderer()
    private let renderQueue = DispatchQueue(label: "\(Log.subsystem).render", qos: .userInteractive)
    private var timer: DispatchSourceTimer?
    private let lock = NSLock()
    private var clock = PauseClock()
    private var mixer = AudioMixBuffer()
    private(set) var outputSize = PixelSize(width: 1920, height: 1080)
    /// Captured area in AppKit global coordinates (screen, area and window modes).
    private(set) var captureRect: CGRect = .zero
    private var bubbleScreenFrame: CGRect?
    var onFatalError: ((Error) -> Void)?
    var onSegment: ((SegmentEntry?, SegmentLog) -> Void)?
    /// Audio is handed to the writer this far behind the video clock, so late mic/system buffers
    /// still land in the mix.
    static let audioLatency = 0.3

    init(request: RecordingRequest, segmentsDirectory: URL, overlays: OverlayStore) {
        self.request = request
        self.segmentsDirectory = segmentsDirectory
        self.overlays = overlays
    }

    static func now() -> Double { CMClockGetTime(CMClockGetHostTimeClock()).seconds }

    /// Main thread: the bubble window's current frame in global AppKit coordinates (nil = hidden).
    func updateBubbleFrame(_ frame: CGRect?) { lock.withLock { bubbleScreenFrame = frame } }

    var elapsed: Double { lock.withLock { clock.elapsed(now: Self.now()) } }
    var isPaused: Bool { lock.withLock { clock.isPaused } }

    static func screen(for display: SCDisplay) -> NSScreen? {
        NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display.displayID }
    }

    func prepare() async throws {
        var source = PixelSize(width: 1920, height: 1080)
        var target: ScreenCapture.Target?
        switch request.mode {
        case .screen:
            guard let display = request.display else { throw err("No display to record") }
            let screen = Self.screen(for: display)
            let scale = screen?.backingScaleFactor ?? 2
            captureRect = screen?.frame ?? CGRect(x: 0, y: 0, width: display.width, height: display.height)
            source = PixelSize(width: Int(captureRect.width * scale), height: Int(captureRect.height * scale))
            target = .display(display)
        case .area:
            guard let display = request.display, let area = request.area else { throw err("No area to record") }
            let screen = Self.screen(for: display)
            let scale = screen?.backingScaleFactor ?? 2
            let displayFrame = screen?.frame ?? CGRect(x: 0, y: 0, width: display.width, height: display.height)
            guard let src = VideoGeometry.sourceRect(selection: Rect(area), display: Rect(displayFrame)) else {
                throw err("The selected area is too small or not on the display")
            }
            captureRect = VideoGeometry.globalRect(sourceRect: src, display: Rect(displayFrame)).cg
            source = PixelSize(width: Int(src.width * scale), height: Int(src.height * scale))
            target = .area(display, src.cg)
        case .window:
            guard let window = request.window else { throw err("No window to record") }
            let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
            captureRect = VideoGeometry.appKitRect(fromCG: Rect(window.frame), primaryHeight: primaryHeight).cg
            let scale = NSScreen.screens.first { $0.frame.intersects(captureRect) }?.backingScaleFactor ?? 2
            source = PixelSize(width: Int(window.frame.width * scale), height: Int(window.frame.height * scale))
            target = .window(window)
        case .camera:
            guard let camera = request.camera else { throw err("No camera available") }
            let s = camera.frameSize
            source = PixelSize(width: Int(s.width), height: Int(s.height))
        }
        outputSize = VideoGeometry.outputSize(source: source, preset: request.quality)

        let wantsSystem = request.audio.usesSystem && request.mode != .camera
        let wantsMic = request.audio.usesMic && request.microphone != nil
        writer = try SegmentedWriter(directory: segmentsDirectory, size: outputSize, fps: request.fps, audio: wantsMic || wantsSystem)
        writer.onSegment = { [weak self] entry, log in self?.onSegment?(entry, log) }
        writer.onStorageError = { [weak self] error in self?.onFatalError?(error) }
        try writer.start()

        if let target {
            screen.onSystemAudio = { [weak self] sample in self?.handleAudio(sample, clock: nil, source: 1) }
            screen.onError = { [weak self] error in self?.onFatalError?(error) }
            // Clicks are highlighted by Reel's own ripple (composited), not SCK's.
            try await screen.start(target: target,
                                   size: CGSize(width: outputSize.width, height: outputSize.height),
                                   fps: request.fps, showsCursor: request.showsCursor,
                                   showClicks: false, systemAudio: wantsSystem)
        }
        // Don't start the timeline on black frames: wait (≤2 s) for the first camera/screen frame.
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            let cameraReady = request.camera == nil || request.camera?.latestFrame != nil
            let screenReady = target == nil || screen.latestFrame != nil
            if cameraReady && screenReady { break }
            try? await Task.sleep(for: .milliseconds(30))
        }
        if wantsMic, let device = request.microphone {
            let mic = MicCapture { [weak self] sample, clock in self?.handleAudio(sample, clock: clock, source: 0) }
            try mic.start(device: device)
            self.mic = mic
        }
    }

    func begin() {
        lock.withLock { clock.begin(at: Self.now()) }
        let t = DispatchSource.makeTimerSource(flags: .strict, queue: renderQueue)
        t.schedule(deadline: .now(), repeating: 1.0 / Double(request.fps), leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in self?.renderTick() }
        t.resume()
        timer = t
        Task { await screen.refreshExclusion() }
    }

    func pause() { lock.withLock { clock.pause(at: Self.now()) } }
    func resume() { lock.withLock { clock.resume(at: Self.now()) } }

    func stop() async throws -> RecordingResult {
        let end: Double = lock.withLock {
            clock.stop(at: Self.now())
            return clock.elapsed(now: Self.now())
        }
        await teardownCapture()
        Log.capture.info("Screen and microphone detached")
        let tail: (start: Int64, samples: [Float])? = lock.withLock { mixer.drain(upToSeconds: end) }
        if let tail { writer.appendAudio(samples: tail.samples, startFrame: tail.start) }
        let log = try await writer.finish(endTime: end)
        Log.writer.info("Final segment log saved")
        return RecordingResult(segmentsDirectory: segmentsDirectory, log: log, duration: end, size: outputSize)
    }

    func cancel() async {
        lock.withLock { clock.stop(at: Self.now()) }
        await teardownCapture()
        writer?.cancel()
    }

    private func teardownCapture() async {
        timer?.cancel()
        timer = nil
        renderQueue.sync {}
        mic?.stop()
        mic = nil
        await screen.stop()
    }

    // MARK: - Real-time paths

    private func renderTick() {
        let now = Self.now()
        let (t, bubbleFrame): (Double?, CGRect?) = lock.withLock { (clock.outputTime(for: now), bubbleScreenFrame) }
        guard let t, let pool = writer.adaptor.pixelBufferPool else { return }
        var out: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out) == kCVReturnSuccess, let out else { return }
        let cameraFrame = request.camera?.latestFrame
        let capture = Rect(captureRect)
        var bubble: CGRect?
        switch request.mode {
        case .screen, .area:
            if let f = bubbleFrame, let r = VideoGeometry.bubbleRect(bubble: Rect(f), captureRect: capture, output: outputSize) {
                bubble = r.cg
            }
        case .window:
            if bubbleFrame != nil { bubble = VideoGeometry.cornerBubble(output: outputSize).cg }
        case .camera:
            break
        }
        var layers: [CIImage] = []
        if request.mode != .camera, captureRect.width > 0 {
            let scale = CGFloat(outputSize.width) / captureRect.width
            let size = outputSize
            let map: (Point) -> CGPoint = { p in
                let m = VideoGeometry.map(x: p.x, y: p.y, captureRect: capture, output: size)
                return CGPoint(x: m.x, y: m.y)
            }
            if let strokes = overlayRenderer.strokes(overlays.drawingState, size: outputSize, scale: scale, map: map) { layers.append(strokes) }
            if request.showClicks {
                for c in overlays.activeClicks(now: now) {
                    guard let look = ClickRipple.appearance(age: now - c.time), capture.contains(x: c.x, y: c.y) else { continue }
                    if let ring = OverlayRenderer.ring(center: map(Point(x: c.x, y: c.y)), radius: CGFloat(look.radius) * scale,
                                                       alpha: CGFloat(look.alpha), lineWidth: 3 * scale) { layers.append(ring) }
                }
            }
        }
        compositor.render(screen: screen.latestFrame, camera: cameraFrame, bubble: bubble, cameraOnly: request.mode == .camera, overlays: layers, into: out)
        writer.appendVideo(out, at: t)
        // Hand finished audio to the writer, a little behind the video clock.
        let mixed: (start: Int64, samples: [Float])? = lock.withLock { mixer.drain(upToSeconds: t - Self.audioLatency) }
        if let mixed { writer.appendAudio(samples: mixed.samples, startFrame: mixed.start) }
    }

    private func handleAudio(_ sample: CMSampleBuffer, clock syncClock: CMClock?, source: Int) {
        var pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let host = CMClockGetHostTimeClock()
        if let syncClock, !CFEqual(syncClock, host) { pts = CMSyncConvertTime(pts, from: syncClock, to: host) }
        guard let pcm = AudioSamples.interleavedFloats(sample) else { return }
        lock.withLock {
            guard let t = clock.outputTime(for: pts.seconds) else { return }
            mixer.add(source: source, seconds: t, samples: pcm.samples, channels: pcm.channels)
        }
    }

    private func err(_ message: String) -> NSError { NSError(domain: "Reel", code: 20, userInfo: [NSLocalizedDescriptionKey: message]) }
}

extension Rect {
    init(_ r: CGRect) { self.init(x: r.minX, y: r.minY, width: r.width, height: r.height) }
    var cg: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}
