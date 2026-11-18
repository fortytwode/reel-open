import AppKit
import Combine
import ReelCore

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    enum Phase: Equatable {
        case idle
        case preparing
        case countdown(Int)
        case recording
        case paused
        case finishing
    }

    private let settingsStore = SettingsStore()
    let library: LibraryStore

    @Published var settings: ReelSettings { didSet { if persistSettings && settings != oldValue { settingsStore.save(settings) } } }
    /// Off for CLI verification runs so test overrides don't change the user's settings.
    var persistSettings = true
    @Published var recordings: [Recording] = []
    @Published var account: CloudSession? {
        didSet {
            if oldValue?.userID != account?.userID {
                accountGeneration &+= 1
                if oldValue != nil { Publisher.shared.cancelMeetingProcessing() }
            }
        }
    }
    private(set) var accountGeneration: UInt64 = 0
    @Published var phase: Phase = .idle
    @Published var uploadProgress: [String: Double] = [:]
    @Published var meetingMode = false
    @Published var meetingTitle = ""
    @Published var meetingAttendees = ""
    @Published var meetingMicrophoneEnabled = true
    @Published var meetingCalendarOccurrenceID: String?
    @Published var meetingCalendarReference: MeetingCalendarReference?
    @Published var lastError: String?
    /// Mirror of the recording's drawing state for the control bar (the source of truth is the
    /// session's OverlayStore).
    @Published var drawing = DrawingState()
    /// Recordings rebuilt at launch after an interruption.
    @Published var recoveredCount = 0

    init() {
        settings = settingsStore.load()
        library = LibraryStore(root: LibraryStore.defaultRoot)
        try? FileManager.default.createDirectory(at: library.root, withIntermediateDirectories: true)
        reloadLibrary()
        Task {
            self.account = await CloudAuth.shared.current
            if self.account != nil {
                await Publisher.shared.syncCloudLibrary()
                Publisher.shared.resumeMeetingProcessing()
            }
        }
    }

    var isBusy: Bool { phase != .idle }

    func effectiveSettings() -> ReelSettings {
        guard meetingMode else { return settings }
        var result = MeetingCapturePolicy.settings(from: settings)
        if !meetingMicrophoneEnabled { result.audio = .systemOnly }
        return result
    }

    func existingMeeting(forOccurrence id: String?) -> Recording? {
        MeetingCapturePolicy.existingOccurrence(in: recordings, id: id)
    }

    func reloadLibrary() { recordings = library.load() }

    func update(_ r: Recording) {
        do { try library.save(r) } catch { Log.app.error("Save recording failed: \(error.localizedDescription, privacy: .public)") }
        if let i = recordings.firstIndex(where: { $0.id == r.id }) { recordings[i] = r } else { recordings.insert(r, at: 0) }
    }

    func recording(id: String) -> Recording? { recordings.first { $0.id == id } }

    func signIn() async {
        do {
            let anchor = NSApp.keyWindow ?? NSApp.windows.first { $0.isVisible } ?? NSWindow()
            NSApp.activate(ignoringOtherApps: true)
            let token = try await GoogleLogin().signIn(presenting: anchor)
            account = try await CloudAuth.shared.signInWithGoogle(idToken: token)
            lastError = nil
            await Publisher.shared.syncCloudLibrary()
            Publisher.shared.resumeMeetingProcessing()
            Toast.show("Signed in as \(account?.email ?? "")")
            // Return to the latest finished recording after interactive sign-in. Older
            // waiting uploads must not overwrite its clipboard link or open extra tabs.
            let waiting = recordings.filter(\.awaitsUploadOnSignIn)
            let latest = waiting.max { $0.createdAt < $1.createdAt }?.id
            for r in waiting {
                Publisher.shared.publish(r, copyLink: settings.copyLinkOnStop && r.id == latest)
            }
        } catch is CancellationError {
        } catch {
            lastError = error.localizedDescription
            Toast.show(error.localizedDescription, isError: true)
        }
    }

    func signOut() async {
        await CloudAuth.shared.signOut()
        account = nil
    }
}
