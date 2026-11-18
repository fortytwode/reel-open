import AppKit
import ScreenCaptureKit

/// ScreenCaptureKit stream (the API Loom's recorder uses). Our own windows (camera bubble,
/// control bar, countdown, toasts) are kept out with `excludingApplications: [Reel]`, like
/// Loom's ExcludedApplicationFilter; the bubble is then composited in-process (see Compositor).
final class ScreenCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    enum Target {
        case display(SCDisplay)
        /// Part of a display: `sourceRect` in points, relative to the display, top-left origin.
        case area(SCDisplay, CGRect)
        case window(SCWindow)
    }

    private var stream: SCStream?
    private let videoQueue = DispatchQueue(label: "com.rocketshiphq.reel.screen", qos: .userInteractive)
    private let audioQueue = DispatchQueue(label: "com.rocketshiphq.reel.sysaudio", qos: .userInteractive)
    private let lock = NSLock()
    private var latest: CVPixelBuffer?
    var onSystemAudio: ((CMSampleBuffer) -> Void)?
    var onError: ((Error) -> Void)?

    var latestFrame: CVPixelBuffer? { lock.withLock { latest } }

    /// Include windows on other Spaces and outside the visible desktop. A single-window
    /// stream uses a desktop-independent filter, so visibility is not a selection limit.
    static func shareableContent() async throws -> SCShareableContent {
        try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    }

    /// Picker metadata is a snapshot: the window may resize or close while the user chooses.
    static func refreshedWindow(_ selected: SCWindow) async throws -> SCWindow {
        let content = try await shareableContent()
        guard let window = content.windows.first(where: {
            $0.windowID == selected.windowID && $0.owningApplication?.processID == selected.owningApplication?.processID
        }) else {
            throw NSError(domain: "Reel", code: 21, userInfo: [NSLocalizedDescriptionKey: "That window closed. Choose another window to record."])
        }
        return window
    }

    /// Reel's own windows (bubble, control bar, countdown, toasts) are excluded by app. The
    /// filter is built from fresh content that includes off-screen windows, because an app
    /// only appears in `applications` once it owns a window.
    static func filter(for target: Target) async throws -> SCContentFilter {
        switch target {
        case .display(let display), .area(let display, _):
            let fresh = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            let pid = ProcessInfo.processInfo.processIdentifier
            let me = fresh.applications.filter { $0.processID == pid || $0.bundleIdentifier == Bundle.main.bundleIdentifier }
            if me.isEmpty { Log.capture.error("Reel not found in shareable applications; own windows may be visible") }
            let d = fresh.displays.first { $0.displayID == display.displayID } ?? display
            return SCContentFilter(display: d, excludingApplications: me, exceptingWindows: [])
        case .window(let window):
            return SCContentFilter(desktopIndependentWindow: window)
        }
    }

    private var target: Target?

    /// Re-applies the exclusion once all of Reel's recording windows are on screen.
    func refreshExclusion() async {
        guard let stream, let target else { return }
        if case .window = target { return }
        do { try await stream.updateContentFilter(Self.filter(for: target)) }
        catch { Log.capture.error("updateContentFilter: \(error.localizedDescription, privacy: .public)") }
    }

    func start(target: Target, size: CGSize, fps: Int, showsCursor: Bool, showClicks: Bool, systemAudio: Bool) async throws {
        let filter = try await Self.filter(for: target)
        self.target = target
        let config = SCStreamConfiguration()
        config.width = Int(size.width)
        config.height = Int(size.height)
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.colorSpaceName = CGColorSpace.sRGB
        config.queueDepth = 6
        config.showsCursor = showsCursor
        config.showMouseClicks = showClicks
        if case .area(_, let rect) = target { config.sourceRect = rect }
        config.scalesToFit = true
        config.preservesAspectRatio = true
        if systemAudio {
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true
            config.sampleRate = 48_000
            config.channelCount = 2
        }
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue)
        if systemAudio { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue) }
        try await stream.startCapture()
        self.stream = stream
        do { try await waitForFirstFrame() }
        catch { await stop(); throw error }
        Log.capture.info("SCStream started \(Int(size.width))x\(Int(size.height))@\(fps) systemAudio=\(systemAudio)")
    }

    /// Starting SCStream is not proof it supplied video. Never let the compositor turn
    /// an unavailable source into an apparently successful black recording.
    func waitForFirstFrame(timeout: TimeInterval = 2) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while latestFrame == nil && Date() < deadline {
            try await Task.sleep(for: .milliseconds(30))
        }
        try Task.checkCancellation()
        guard latestFrame != nil else {
            throw NSError(domain: "Reel", code: 22, userInfo: [NSLocalizedDescriptionKey: "The selected screen or window did not provide video. Open or restore the window, then choose it again."])
        }
    }

    func stop() async {
        guard let stream else { return }
        self.stream = nil
        do { try await stream.stopCapture() } catch { Log.capture.error("stopCapture: \(error.localizedDescription, privacy: .public)") }
        lock.withLock { latest = nil }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sampleBuffer.isValid else { return }
        switch type {
        case .screen:
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let raw = attachments.first?[.status] as? Int,
                  SCFrameStatus(rawValue: raw) == .complete,
                  let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            lock.withLock { latest = pb }
        case .audio:
            onSystemAudio?(sampleBuffer)
        default:
            break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Log.capture.error("SCStream stopped: \(error.localizedDescription, privacy: .public)")
        onError?(error)
    }
}
