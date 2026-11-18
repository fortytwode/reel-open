import Foundation

/// Reel's configurable global shortcuts.
public enum ShortcutAction: String, Codable, CaseIterable, Sendable {
    case startStop, pauseResume, cancel, toggleDrawing
    public var label: String {
        switch self {
        case .startStop: "Start / stop recording"
        case .pauseResume: "Pause / resume"
        case .cancel: "Cancel recording"
        case .toggleDrawing: "Drawing on / off"
        }
    }
    public var defaultShortcut: Shortcut {
        switch self {
        case .startStop: .startStop
        case .pauseResume: .pauseResume
        case .cancel: .cancel
        case .toggleDrawing: .toggleDrawing
        }
    }
    /// Registered only while a recording is running (so they don't steal keys otherwise).
    public var onlyWhileRecording: Bool { self != .startStop }
}

/// Carbon virtual key codes → display names (Carbon `kVK_*` constants).
public enum KeyNames {
    static let names: [UInt32: String] = [
        0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X", 8: "C", 9: "V", 11: "B", 12: "Q", 13: "W",
        14: "E", 15: "R", 16: "Y", 17: "T", 18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 24: "=", 25: "9",
        26: "7", 27: "-", 28: "8", 29: "0", 30: "]", 31: "O", 32: "U", 33: "[", 34: "I", 35: "P", 36: "↩", 37: "L",
        38: "J", 39: "'", 40: "K", 41: ";", 42: "\\", 43: ",", 44: "/", 45: "N", 46: "M", 47: ".", 48: "⇥", 49: "Space",
        50: "`", 51: "⌫", 53: "⎋", 96: "F5", 97: "F6", 98: "F7", 99: "F3", 100: "F8", 101: "F9", 103: "F11",
        105: "F13", 107: "F14", 109: "F10", 111: "F12", 113: "F15", 115: "↖", 116: "⇞", 117: "⌦", 118: "F4",
        119: "↘", 120: "F2", 121: "⇟", 122: "F1", 123: "←", 124: "→", 125: "↓", 126: "↑",
    ]

    public static func name(for keyCode: UInt32) -> String? { names[keyCode] }

    /// Escape alone cancels the recorder field; modifier-only key codes can't be shortcuts.
    public static func isUsable(_ keyCode: UInt32) -> Bool { names[keyCode] != nil && keyCode != 53 }

    /// Cocoa NSEvent.ModifierFlags raw bits → Carbon modifier mask.
    public static func carbonModifiers(cocoa flags: UInt) -> UInt32 {
        var m: UInt32 = 0
        if flags & (1 << 17) != 0 { m |= Shortcut.shift }
        if flags & (1 << 18) != 0 { m |= Shortcut.control }
        if flags & (1 << 19) != 0 { m |= Shortcut.option }
        if flags & (1 << 20) != 0 { m |= Shortcut.cmd }
        return m
    }

    /// Builds a shortcut from a key event, or nil if it's not a usable global shortcut.
    public static func shortcut(keyCode: UInt32, cocoaFlags: UInt) -> Shortcut? {
        guard isUsable(keyCode), let n = name(for: keyCode) else { return nil }
        let s = Shortcut(keyCode: keyCode, modifiers: carbonModifiers(cocoa: cocoaFlags), key: n.lowercased())
        return s.isValid ? s : nil
    }
}

/// A shortcut macOS itself uses (System Settings ▸ Keyboard ▸ Keyboard Shortcuts), parsed from
/// the `com.apple.symbolichotkeys` preferences.
public struct SystemHotKey: Equatable, Sendable {
    public var keyCode: UInt32
    public var modifiers: UInt32
    public var name: String
    public init(keyCode: UInt32, modifiers: UInt32, name: String) {
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.name = name
    }

    static let knownNames: [Int: String] = [
        7: "Move focus to the menu bar", 8: "Move focus to the Dock", 9: "Move focus to active or next window",
        10: "Move focus to window toolbar", 11: "Move focus to floating window", 27: "Move focus to next window",
        28: "Save picture of screen as a file", 29: "Copy picture of screen to the clipboard",
        30: "Save picture of selected area as a file", 31: "Copy picture of selected area to the clipboard",
        32: "Mission Control", 33: "Application windows", 36: "Show Desktop", 52: "Turn Dock hiding on/off",
        57: "Move focus to status menus", 60: "Select the previous input source", 61: "Select next source in Input menu",
        64: "Show Spotlight search", 65: "Show Finder search window", 79: "Move left a space", 81: "Move right a space",
        118: "Switch to Desktop 1", 119: "Switch to Desktop 2", 120: "Switch to Desktop 3", 121: "Switch to Desktop 4",
        162: "Turn VoiceOver on or off", 175: "Turn Do Not Disturb on/off", 184: "Screenshot and recording options",
        190: "Quick Note", 222: "Turn Stage Manager on/off",
    ]

    /// `AppleSymbolicHotKeys` dictionary → enabled shortcuts with a key code.
    public static func parse(symbolicHotKeys dict: [String: Any]) -> [SystemHotKey] {
        var out: [SystemHotKey] = []
        for (idString, raw) in dict {
            guard let entry = raw as? [String: Any],
                  (entry["enabled"] as? Bool) ?? ((entry["enabled"] as? Int) == 1),
                  let value = entry["value"] as? [String: Any],
                  let params = value["parameters"] as? [Any], params.count >= 3,
                  let keyCode = (params[1] as? NSNumber)?.intValue, keyCode >= 0, keyCode != 65535,
                  let flags = (params[2] as? NSNumber)?.uintValue else { continue }
            let id = Int(idString) ?? -1
            let name = knownNames[id] ?? "macOS shortcut #\(idString)"
            out.append(SystemHotKey(keyCode: UInt32(keyCode), modifiers: KeyNames.carbonModifiers(cocoa: flags), name: name))
        }
        return out.sorted { $0.name < $1.name }
    }
}

public enum ShortcutConflict: Equatable, Sendable {
    case duplicate(ShortcutAction)
    case system(String)
    case common(String)
    /// Another app already registered it (RegisterEventHotKey failed).
    case registration(String)

    public var message: String {
        switch self {
        case .duplicate(let a): "Already used for “\(a.label)”."
        case .system(let n): "macOS uses this for “\(n)”."
        case .common(let n): "Most apps use this for \(n)."
        case .registration(let why): why
        }
    }
    /// Duplicates within Reel can't work at all; the rest are warnings the user may accept.
    public var isBlocking: Bool { if case .duplicate = self { return true } else { return false } }
}

public enum ShortcutConflicts {
    /// ⌘-only shortcuts nearly every app relies on.
    static let common: [UInt32: String] = [
        12: "Quit", 13: "Close", 0: "Select All", 8: "Copy", 9: "Paste", 7: "Cut", 6: "Undo", 1: "Save", 45: "New",
        31: "Open", 35: "Print", 17: "New Tab", 3: "Find", 4: "Hide", 46: "Minimize", 43: "Settings", 48: "App Switcher",
        49: "Spotlight",
    ]

    public static func find(_ s: Shortcut, for action: ShortcutAction, assigned: [ShortcutAction: Shortcut], system: [SystemHotKey]) -> [ShortcutConflict] {
        var out: [ShortcutConflict] = []
        for other in ShortcutAction.allCases where other != action {
            if let o = assigned[other], o.keyCode == s.keyCode, o.modifiers == s.modifiers { out.append(.duplicate(other)) }
        }
        for h in system where h.keyCode == s.keyCode && h.modifiers == s.modifiers { out.append(.system(h.name)) }
        if s.modifiers == Shortcut.cmd, let n = common[s.keyCode] { out.append(.common("⌘\(KeyNames.name(for: s.keyCode) ?? "") (\(n))")) }
        return out
    }
}
