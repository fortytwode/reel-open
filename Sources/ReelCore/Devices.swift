import Foundation

/// A capture device as seen by the app (built from AVCaptureDevice, kept AVFoundation-free here).
public struct DeviceInfo: Equatable, Sendable, Identifiable {
    public enum Kind: String, Sendable { case builtIn, external, continuity, virtual }
    public var id: String
    public var name: String
    public var kind: Kind
    public init(id: String, name: String, kind: Kind) {
        self.id = id
        self.name = name
        self.kind = kind
    }

    /// iPhone/iPad Continuity devices: never picked automatically (they appear whenever a
    /// phone is nearby, and Loom-style auto-switching to them is surprising).
    public var isContinuity: Bool {
        kind == .continuity || name.localizedCaseInsensitiveContains("iphone") || name.localizedCaseInsensitiveContains("ipad")
    }
}

public enum DeviceDefaults {
    public static let preferredCameraName = "MacBook Pro Camera"

    /// Saved choice if still present → "MacBook Pro Camera" → any built-in → first
    /// non-Continuity, non-virtual → nil. Continuity cameras are only used when explicitly saved.
    public static func camera(from devices: [DeviceInfo], savedID: String?) -> DeviceInfo? {
        if let savedID, let saved = devices.first(where: { $0.id == savedID }) { return saved }
        if let exact = devices.first(where: { $0.name == preferredCameraName }) { return exact }
        if let builtIn = devices.first(where: { $0.kind == .builtIn && !$0.isContinuity }) { return builtIn }
        return devices.first(where: { !$0.isContinuity && $0.kind != .virtual })
    }

    /// Saved choice → system default input (unless it's an iPhone) → built-in mic → first non-Continuity.
    public static func microphone(from devices: [DeviceInfo], savedID: String?, systemDefaultID: String?) -> DeviceInfo? {
        if let savedID, let saved = devices.first(where: { $0.id == savedID }) { return saved }
        if let systemDefaultID, let d = devices.first(where: { $0.id == systemDefaultID }), !d.isContinuity { return d }
        if let builtIn = devices.first(where: { $0.kind == .builtIn && !$0.isContinuity }) { return builtIn }
        return devices.first(where: { !$0.isContinuity })
    }
}
