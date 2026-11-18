import AVFoundation
import CoreAudio
import ReelCore

/// AVFoundation device enumeration mapped onto ReelCore's DeviceInfo so the default-picking
/// policy (never auto-select iPhone Continuity cameras) is unit-tested.
enum CaptureDevices {
    static func cameras() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera, .deskViewCamera],
            mediaType: .video, position: .unspecified
        ).devices.filter { $0.deviceType != .deskViewCamera }
    }

    static func microphones() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
    }

    static func info(_ d: AVCaptureDevice) -> DeviceInfo {
        let kind: DeviceInfo.Kind
        switch d.deviceType {
        case .builtInWideAngleCamera: kind = .builtIn
        case .continuityCamera: kind = .continuity
        case .microphone:
            kind = d.transportType == Int32(bitPattern: kAudioDeviceTransportTypeBuiltIn) ? .builtIn
                : d.transportType == Int32(bitPattern: kAudioDeviceTransportTypeVirtual) ? .virtual
                : (d.transportType == Int32(bitPattern: kAudioDeviceTransportTypeContinuityCaptureWired)
                   || d.transportType == Int32(bitPattern: kAudioDeviceTransportTypeContinuityCaptureWireless)) ? .continuity
                : .external
        default: kind = d.isContinuityCamera ? .continuity : .external
        }
        return DeviceInfo(id: d.uniqueID, name: d.localizedName, kind: kind)
    }

    static func defaultCamera(savedID: String?) -> AVCaptureDevice? {
        let all = cameras()
        guard let pick = DeviceDefaults.camera(from: all.map(info), savedID: savedID) else { return nil }
        return all.first { $0.uniqueID == pick.id }
    }

    static func defaultMicrophone(savedID: String?) -> AVCaptureDevice? {
        let all = microphones()
        let systemDefault = AVCaptureDevice.default(for: .audio)?.uniqueID
        guard let pick = DeviceDefaults.microphone(from: all.map(info), savedID: savedID, systemDefaultID: systemDefault) else { return nil }
        return all.first { $0.uniqueID == pick.id }
    }
}
