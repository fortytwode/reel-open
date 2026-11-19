import AVFoundation
import CoreVideo
import ReelCore

/// Camera capturer. One AVCaptureSession feeds both the on-screen bubble preview and a BGRA
/// data output whose latest frame the compositor draws into the recording, Loom-style
/// "secondary capturer" for the camera. With a background effect on, frames go through
/// `CameraEffects` first and the bubble shows the processed frames.
final class CameraCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "com.rocketshiphq.reel.camera")
    private let output = AVCaptureVideoDataOutput()
    private let lock = NSLock()
    private var latest: CVPixelBuffer?
    private var input: AVCaptureDeviceInput?
    private(set) var device: AVCaptureDevice?
    let effects = CameraEffects()
    private var effectMode: CameraBackground = .none
    /// Processed frames for the bubble preview (camera queue). Only called while an effect is on.
    var onProcessedFrame: ((CVPixelBuffer) -> Void)?

    var latestFrame: CVPixelBuffer? { lock.withLock { latest } }
    var background: CameraBackground { lock.withLock { effectMode } }

    func setBackground(_ mode: CameraBackground, imagePath: String?) {
        queue.async { [self] in
            effects.setBackgroundImage(path: imagePath)
            lock.withLock { effectMode = mode }
        }
    }

    var frameSize: CGSize {
        guard let d = device else { return CGSize(width: 1280, height: 720) }
        let dims = CMVideoFormatDescriptionGetDimensions(d.activeFormat.formatDescription)
        return CGSize(width: Int(dims.width), height: Int(dims.height))
    }

    func start(device: AVCaptureDevice) throws {
        if self.device?.uniqueID == device.uniqueID, session.isRunning { return }
        session.beginConfiguration()
        if let input { session.removeInput(input) }
        if session.canSetSessionPreset(.hd1280x720) { session.sessionPreset = .hd1280x720 } else { session.sessionPreset = .high }
        let newInput = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(newInput) else {
            session.commitConfiguration()
            throw NSError(domain: "Reel", code: 1, userInfo: [NSLocalizedDescriptionKey: "Can't use camera \(device.localizedName)"])
        }
        session.addInput(newInput)
        input = newInput
        if !session.outputs.contains(output) {
            output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            output.alwaysDiscardsLateVideoFrames = true
            output.setSampleBufferDelegate(self, queue: queue)
            if session.canAddOutput(output) { session.addOutput(output) }
        }
        session.commitConfiguration()
        self.device = device
        lock.withLock { latest = nil }
        if !session.isRunning { queue.async { [session] in session.startRunning() } }
        Log.capture.info("Camera started: \(device.localizedName, privacy: .public)")
    }

    func stop() {
        queue.async { [session] in if session.isRunning { session.stopRunning() } }
        lock.withLock { latest = nil }
    }

    func stopAndWait() async {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                if session.isRunning { session.stopRunning() }
                lock.withLock { latest = nil }
                continuation.resume()
            }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let mode = lock.withLock { effectMode }
        if mode == .none {
            lock.withLock { latest = pb }
            return
        }
        let processed = effects.process(pb, mode: mode) ?? pb
        lock.withLock { latest = processed }
        onProcessedFrame?(processed)
    }
}
