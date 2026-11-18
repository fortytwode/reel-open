import AppKit
import Carbon
import ReelCore

/// System-wide shortcuts via Carbon RegisterEventHotKey: no Accessibility or Input Monitoring
/// permission needed, and only the registered combinations are ever seen by Reel. All of them
/// are configurable in Settings (ShortcutAction); conflicts are detected there.
@MainActor
final class HotKeys {
    static let shared = HotKeys()
    private var refs: [UInt32: EventHotKeyRef] = [:]
    fileprivate var actions: [UInt32: () -> Void] = [:]
    private var handler: EventHandlerRef?
    /// Registration failures by action (another app holds the combination).
    private(set) var registrationErrors: [ShortcutAction: String] = [:]
    var registrationError: String? { registrationErrors[.startStop] }

    static func id(for action: ShortcutAction) -> UInt32 {
        switch action {
        case .startStop: 1
        case .pauseResume: 2
        case .cancel: 3
        case .toggleDrawing: 4
        }
    }
    static let probeID: UInt32 = 99

    private func installHandler() {
        guard handler == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetEventDispatcherTarget(), { _, event, _ -> OSStatus in
            var hk = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            let id = hk.id
            DispatchQueue.main.async { MainActor.assumeIsolated { HotKeys.shared.actions[id]?() } }
            return noErr
        }, 1, &spec, nil, &handler)
    }

    private func registerRaw(id: UInt32, _ shortcut: Shortcut) -> OSStatus {
        installHandler()
        if let ref = refs.removeValue(forKey: id) { UnregisterEventHotKey(ref) }
        var ref: EventHotKeyRef?
        let hkID = EventHotKeyID(signature: OSType(0x5245454C), id: id)   // 'REEL'
        let status = RegisterEventHotKey(shortcut.keyCode, shortcut.modifiers, hkID, GetEventDispatcherTarget(), 0, &ref)
        if status == noErr, let ref { refs[id] = ref }
        return status
    }

    @discardableResult
    func register(_ action: ShortcutAction, _ shortcut: Shortcut, handler: @escaping () -> Void) -> Bool {
        let id = Self.id(for: action)
        let status = registerRaw(id: id, shortcut)
        guard status == noErr else {
            actions[id] = nil
            registrationErrors[action] = "\(shortcut.display) is already used by another app (\(status))."
            Log.app.error("Hotkey \(shortcut.display, privacy: .public) registration failed: \(status)")
            return false
        }
        actions[id] = handler
        registrationErrors[action] = nil
        return true
    }

    func unregister(_ action: ShortcutAction) {
        let id = Self.id(for: action)
        if let ref = refs.removeValue(forKey: id) { UnregisterEventHotKey(ref) }
        actions[id] = nil
    }

    /// Whether the system would let Reel register `shortcut` right now (another app may hold it
    /// exclusively). Shortcuts Reel itself holds are skipped by the caller.
    func probe(_ shortcut: Shortcut) -> String? {
        let status = registerRaw(id: Self.probeID, shortcut)
        if let ref = refs.removeValue(forKey: Self.probeID) { UnregisterEventHotKey(ref) }
        return status == noErr ? nil : "Another app has already registered \(shortcut.display)."
    }

    func registerMain(_ shortcut: Shortcut) {
        register(.startStop, shortcut) { RecorderController.shared.toggle() }
    }

    func registerRecordingKeys(_ settings: ReelSettings) {
        register(.pauseResume, settings.pauseShortcut) { RecorderController.shared.pauseResume() }
        register(.cancel, settings.cancelShortcut) { RecorderController.shared.cancel() }
        register(.toggleDrawing, settings.drawShortcut) { RecorderController.shared.toggleDrawing() }
    }

    func unregisterRecordingKeys() {
        for a in ShortcutAction.allCases where a.onlyWhileRecording { unregister(a) }
    }

    /// macOS's own enabled shortcuts (System Settings ▸ Keyboard ▸ Keyboard Shortcuts).
    static func systemHotKeys() -> [SystemHotKey] {
        guard let dict = CFPreferencesCopyAppValue("AppleSymbolicHotKeys" as CFString, "com.apple.symbolichotkeys" as CFString) as? [String: Any] else { return [] }
        return SystemHotKey.parse(symbolicHotKeys: dict)
    }
}
