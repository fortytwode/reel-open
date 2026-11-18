import Foundation
import ReelCore

/// Settings for this deployment. Preserve unreadable files alongside their replacement.
final class SettingsStore {
    static let directory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return OrganizationState.current.directory(under: base)
    }()
    private let url = SettingsStore.directory.appendingPathComponent("settings.json")

    func load() -> ReelSettings {
        guard let data = try? Data(contentsOf: url) else { return ReelSettings() }
        do { return try JSONDecoder().decode(ReelSettings.self, from: data) }
        catch {
            let backup = url.deletingPathExtension().appendingPathExtension("corrupt-\(Int(Date().timeIntervalSince1970)).json")
            try? FileManager.default.moveItem(at: url, to: backup)
            Log.app.error("settings.json unreadable; moved to \(backup.lastPathComponent, privacy: .public)")
            return ReelSettings()
        }
    }

    func save(_ settings: ReelSettings) {
        do {
            try FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true)
            let e = JSONEncoder()
            e.outputFormatting = [.prettyPrinted, .sortedKeys]
            try e.encode(settings).write(to: url, options: .atomic)
        } catch {
            Log.app.error("Could not save settings: \(error.localizedDescription, privacy: .public)")
        }
    }
}
