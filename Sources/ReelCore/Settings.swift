import Foundation

public enum AudioSource: String, Codable, CaseIterable, Sendable {
    // Mirrors Loom's recorder modes (MicOnly / SystemOnly / MicAndSystem / None).
    case micOnly, systemOnly, micAndSystem, none
    public var label: String {
        switch self {
        case .micOnly: "Microphone"
        case .systemOnly: "System audio only"
        case .micAndSystem: "Microphone + system audio"
        case .none: "No audio"
        }
    }
    public var usesMic: Bool { self == .micOnly || self == .micAndSystem }
    public var usesSystem: Bool { self == .systemOnly || self == .micAndSystem }
}

public enum BubbleSize: String, Codable, CaseIterable, Sendable {
    case small, medium, large
    public var diameter: Double {
        switch self {
        case .small: 160
        case .medium: 220
        case .large: 320
        }
    }
}

/// Global shortcut, stored as a Carbon key code + Carbon modifier mask.
public struct Shortcut: Codable, Equatable, Sendable {
    public var keyCode: UInt32
    public var modifiers: UInt32
    public var key: String

    // Carbon modifier bits (cmdKey, shiftKey, optionKey, controlKey).
    public static let cmd: UInt32 = 1 << 8, shift: UInt32 = 1 << 9, option: UInt32 = 1 << 11, control: UInt32 = 1 << 12

    public init(keyCode: UInt32, modifiers: UInt32, key: String) {
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.key = key
    }

    /// ⌃⌥R. Avoids ⌘⇧R (browser hard reload) and Loom's own ⌘⇧L.
    public static let startStop = Shortcut(keyCode: 15, modifiers: control | option, key: "r")
    /// ⌃⌥P, only registered while recording.
    public static let pauseResume = Shortcut(keyCode: 35, modifiers: control | option, key: "p")
    /// ⌃⌥⌫ cancel (discard), only registered while recording.
    public static let cancel = Shortcut(keyCode: 51, modifiers: control | option, key: "⌫")
    /// ⌃⌥D drawing on/off, only registered while recording.
    public static let toggleDrawing = Shortcut(keyCode: 2, modifiers: control | option, key: "d")

    public var isValid: Bool {
        keyCode <= 127 && !key.isEmpty && modifiers & (Self.cmd | Self.option | Self.control) != 0
            && modifiers & ~(Self.cmd | Self.shift | Self.option | Self.control) == 0
    }

    public var display: String {
        var s = ""
        if modifiers & Self.control != 0 { s += "⌃" }
        if modifiers & Self.option != 0 { s += "⌥" }
        if modifiers & Self.shift != 0 { s += "⇧" }
        if modifiers & Self.cmd != 0 { s += "⌘" }
        return s + (key.count == 1 ? key.uppercased() : key.capitalized)
    }
}

public struct ReelSettings: Codable, Equatable, Sendable {
    public var mode: CaptureMode = .screen
    public var cameraEnabled = true
    public var cameraID: String?
    public var microphoneID: String?
    public var audio: AudioSource = .micOnly
    public var quality: QualityPreset = .p1080
    public var fps: Int = 30
    public var countdownSeconds: Int = 3
    public var showCursor = true
    public var highlightClicks = true
    public var bubbleSize: BubbleSize = .medium
    public var autoUpload = true
    public var copyLinkOnStop = true
    public var shortcut: Shortcut = .startStop
    public var pauseShortcut: Shortcut = .pauseResume
    public var cancelShortcut: Shortcut = .cancel
    public var drawShortcut: Shortcut = .toggleDrawing
    public var displayID: UInt32?
    /// Last area selection (AppKit global coordinates), offered again next time.
    public var lastArea: Rect?
    public var cameraBackground: CameraBackground = .none
    /// Image for `.image` virtual backgrounds (nil = Reel's built-in gradient).
    public var backgroundImagePath: String?
    /// Upload segments while recording so the link plays right after stopping.
    public var liveUpload = true
    /// Also upload a progressive MP4 after stopping (downloads, transcript API consumers).
    public var uploadMP4 = true
    /// Generate title, summary and chapters from the transcript.
    public var aiSummary = true
    /// Locale used for on-device transcription.
    public var transcriptionLocaleIdentifier = "en-US"

    public init() {}

    public func shortcut(for action: ShortcutAction) -> Shortcut {
        switch action {
        case .startStop: shortcut
        case .pauseResume: pauseShortcut
        case .cancel: cancelShortcut
        case .toggleDrawing: drawShortcut
        }
    }

    public mutating func setShortcut(_ s: Shortcut, for action: ShortcutAction) {
        switch action {
        case .startStop: shortcut = s
        case .pauseResume: pauseShortcut = s
        case .cancel: cancelShortcut = s
        case .toggleDrawing: drawShortcut = s
        }
    }

    public var shortcuts: [ShortcutAction: Shortcut] {
        Dictionary(uniqueKeysWithValues: ShortcutAction.allCases.map { ($0, shortcut(for: $0)) })
    }

    // Tolerant decoding: unknown/missing keys fall back to defaults so old files keep working.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = ReelSettings()
        mode = (try? c.decode(CaptureMode.self, forKey: .mode)) ?? d.mode
        cameraEnabled = (try? c.decode(Bool.self, forKey: .cameraEnabled)) ?? d.cameraEnabled
        cameraID = try? c.decode(String.self, forKey: .cameraID)
        microphoneID = try? c.decode(String.self, forKey: .microphoneID)
        audio = (try? c.decode(AudioSource.self, forKey: .audio)) ?? d.audio
        quality = (try? c.decode(QualityPreset.self, forKey: .quality)) ?? d.quality
        let f = (try? c.decode(Int.self, forKey: .fps)) ?? d.fps
        fps = [24, 30, 60].contains(f) ? f : d.fps
        let cd = (try? c.decode(Int.self, forKey: .countdownSeconds)) ?? d.countdownSeconds
        countdownSeconds = min(max(cd, 0), 10)
        showCursor = (try? c.decode(Bool.self, forKey: .showCursor)) ?? d.showCursor
        highlightClicks = (try? c.decode(Bool.self, forKey: .highlightClicks)) ?? d.highlightClicks
        bubbleSize = (try? c.decode(BubbleSize.self, forKey: .bubbleSize)) ?? d.bubbleSize
        autoUpload = (try? c.decode(Bool.self, forKey: .autoUpload)) ?? d.autoUpload
        copyLinkOnStop = (try? c.decode(Bool.self, forKey: .copyLinkOnStop)) ?? d.copyLinkOnStop
        func sc(_ key: CodingKeys, _ fallback: Shortcut) -> Shortcut {
            let s = try? c.decode(Shortcut.self, forKey: key)
            return (s?.isValid == true) ? s! : fallback
        }
        shortcut = sc(.shortcut, d.shortcut)
        pauseShortcut = sc(.pauseShortcut, d.pauseShortcut)
        cancelShortcut = sc(.cancelShortcut, d.cancelShortcut)
        drawShortcut = sc(.drawShortcut, d.drawShortcut)
        displayID = try? c.decode(UInt32.self, forKey: .displayID)
        lastArea = try? c.decode(Rect.self, forKey: .lastArea)
        cameraBackground = (try? c.decode(CameraBackground.self, forKey: .cameraBackground)) ?? d.cameraBackground
        backgroundImagePath = try? c.decode(String.self, forKey: .backgroundImagePath)
        liveUpload = (try? c.decode(Bool.self, forKey: .liveUpload)) ?? d.liveUpload
        uploadMP4 = (try? c.decode(Bool.self, forKey: .uploadMP4)) ?? d.uploadMP4
        aiSummary = (try? c.decode(Bool.self, forKey: .aiSummary)) ?? d.aiSummary
        transcriptionLocaleIdentifier = (try? c.decode(String.self, forKey: .transcriptionLocaleIdentifier)) ?? d.transcriptionLocaleIdentifier
    }
}

/// Camera background effect (Vision person segmentation), like Loom's camera effects.
public enum CameraBackground: String, Codable, CaseIterable, Sendable {
    case none, blur, image
    public var label: String {
        switch self {
        case .none: "None"
        case .blur: "Blur background"
        case .image: "Virtual background"
        }
    }
}
