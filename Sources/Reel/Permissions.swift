import AppKit
import AVFoundation
import CoreGraphics
import Speech

enum Permissions {
    static var screenRecording: Bool { CGPreflightScreenCaptureAccess() }
    static func requestScreenRecording() { _ = CGRequestScreenCaptureAccess() }

    static func status(_ media: AVMediaType) -> AVAuthorizationStatus { AVCaptureDevice.authorizationStatus(for: media) }

    static func request(_ media: AVMediaType) async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: media) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: media)
        default: return false
        }
    }

    static func openSettings(_ pane: String) {
        // pane: Privacy_ScreenCapture, Privacy_Camera, Privacy_Microphone, Privacy_SpeechRecognition
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }

    static func describe(_ s: AVAuthorizationStatus) -> String {
        switch s {
        case .authorized: "granted"
        case .denied: "denied"
        case .restricted: "restricted"
        case .notDetermined: "not requested"
        @unknown default: "unknown"
        }
    }

    static var summary: [String: String] {
        [
            "screenRecording": screenRecording ? "granted" : "not granted",
            "camera": describe(status(.video)),
            "microphone": describe(status(.audio)),
            "speechRecognition": {
                switch SFSpeechRecognizer.authorizationStatus() {
                case .authorized: "granted"
                case .denied: "denied"
                case .restricted: "restricted"
                case .notDetermined: "not requested"
                @unknown default: "unknown"
                }
            }(),
        ]
    }
}
