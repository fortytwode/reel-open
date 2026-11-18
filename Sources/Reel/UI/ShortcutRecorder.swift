import AppKit
import ReelCore
import SwiftUI

/// Settings row that records a new global shortcut for one action. Conflicts are checked
/// against Reel's other shortcuts (blocking), macOS's own shortcuts and common app shortcuts
/// (warnings), and whether another app has already registered the combination.
struct ShortcutRecorderRow: View {
    @ObservedObject var model: AppModel
    let action: ShortcutAction
    @State private var recording = false
    @State private var monitor: Any?
    @State private var message: String?
    @State private var messageIsError = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            LabeledContent(action.label) {
                HStack(spacing: 6) {
                    Button(recording ? "Type shortcut…" : model.settings.shortcut(for: action).display) { recording ? stop() : begin() }
                        .frame(minWidth: 110)
                        .help("Click, then press the new key combination (it needs ⌘, ⌥ or ⌃). Esc cancels.")
                    if model.settings.shortcut(for: action) != action.defaultShortcut {
                        Button("Reset") { apply(action.defaultShortcut) }.buttonStyle(.link)
                    }
                }
            }
            if let message {
                Text(message).font(.caption).foregroundStyle(messageIsError ? Color.red : Color.orange)
            } else if let e = HotKeys.shared.registrationErrors[action] {
                Text(e).font(.caption).foregroundStyle(.red)
            }
        }
        .onDisappear { stop() }
    }

    private func begin() {
        message = nil
        recording = true
        // Reel's own start/stop hotkey would otherwise swallow the keys being recorded.
        HotKeys.shared.unregister(.startStop)
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == 53 && event.modifierFlags.intersection([.command, .option, .control]).isEmpty {
                stop()
                return nil
            }
            guard let s = KeyNames.shortcut(keyCode: UInt32(event.keyCode), cocoaFlags: event.modifierFlags.rawValue) else {
                message = "Use ⌘, ⌥ or ⌃ with a key."
                messageIsError = true
                return nil
            }
            apply(s)
            stop()
            return nil
        }
    }

    private func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        if recording { HotKeys.shared.registerMain(model.settings.shortcut) }
        recording = false
    }

    private func apply(_ s: Shortcut) {
        let conflicts = ShortcutConflicts.find(s, for: action, assigned: model.settings.shortcuts, system: HotKeys.systemHotKeys())
        if let blocking = conflicts.first(where: \.isBlocking) {
            message = "\(s.display): \(blocking.message)"
            messageIsError = true
            return
        }
        var warnings = conflicts.map(\.message)
        let heldByReel = model.settings.shortcuts.values.contains { $0.keyCode == s.keyCode && $0.modifiers == s.modifiers }
        if !heldByReel, let taken = HotKeys.shared.probe(s) { warnings.append(taken) }
        model.settings.setShortcut(s, for: action)
        switch action {
        case .startStop: HotKeys.shared.registerMain(s)
        default:
            if [.recording, .paused].contains(model.phase) { HotKeys.shared.registerRecordingKeys(model.settings) }
        }
        message = warnings.isEmpty ? nil : "\(s.display) saved, but: " + warnings.joined(separator: " ")
        messageIsError = false
    }
}
