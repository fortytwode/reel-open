import AVFoundation

/// Microphone capturer: AVCaptureSession + AVCaptureAudioDataOutput converted to 48 kHz mono
/// Float32 so the writer always gets one predictable format.
final class MicCapture: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "com.rocketshiphq.reel.mic")
    private let output = AVCaptureAudioDataOutput()
    private let handler: (CMSampleBuffer, CMClock?) -> Void
    private(set) var deviceName = ""

    init(handler: @escaping (CMSampleBuffer, CMClock?) -> Void) {
        self.handler = handler
    }

    func start(device: AVCaptureDevice) throws {
        session.beginConfiguration()
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            throw NSError(domain: "Reel", code: 2, userInfo: [NSLocalizedDescriptionKey: "Can't use microphone \(device.localizedName)"])
        }
        session.addInput(input)
        output.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
        ]
        output.setSampleBufferDelegate(self, queue: queue)
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()
        deviceName = device.localizedName
        session.startRunning()
        Log.capture.info("Mic started: \(device.localizedName, privacy: .public)")
    }

    func stop() {
        if session.isRunning { session.stopRunning() }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        handler(sampleBuffer, session.synchronizationClock)
    }
}
