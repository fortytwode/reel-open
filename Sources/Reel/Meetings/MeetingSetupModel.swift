import AppKit
import ApplicationServices
import Combine
import EventKit
import ReelCore

/// All access requests are explicit actions. Foreground observation never requests screen access.
@MainActor
final class MeetingSetupModel: ObservableObject {
    @Published var step = 0
    @Published var participantConsent = false
    @Published private(set) var calendarAccessAllowed = false
    @Published private(set) var calendarNeedsSettings = false
    @Published private(set) var calendarCount = 0
    @Published private(set) var selectedCalendarCount = 0
    @Published private(set) var meetingCount = 0
    @Published private(set) var screenCaptureVerified = false
    @Published private(set) var accessibilityAllowed = false
    @Published private(set) var chromeAvailable = false
    @Published private(set) var busy = false
    @Published private(set) var status = ""
    @Published private(set) var enabled = false
    @Published private(set) var completed = false
    var willEnableJoining: Bool { joining.setupWillEnableJoining }

    private struct Scope: Equatable {
        let ids: Set<String>
        let useAll: Bool
    }
    private let discovery = CalendarDiscovery()
    private let joining = MeetingJoinCoordinator.shared
    private var pendingAction: Task<Void, Never>?
    private var generation = UUID()
    private var active = true
    private var observedOwner: String?
    private var observedGeneration: UInt64?
    private var observedScope: Scope?
    private var observedCalendarIDs: Set<String>?

    init() {}

    var readiness: MeetingSetupReadiness {
        MeetingSetupReadiness(calendarAccessAllowed: calendarAccessAllowed,
            selectedCalendarCount: selectedCalendarCount, screenCaptureVerified: screenCaptureVerified,
            accessibilityAllowed: accessibilityAllowed, chromeAvailable: chromeAvailable)
    }

    func cancelPendingActions() {
        active = false
        generation = UUID()
        pendingAction?.cancel()
        pendingAction = nil
        busy = false
    }

    func connectCalendars() {
        perform { token in
            await self.discovery.connect()
            guard self.isCurrent(token) else { return }
            await self.refreshObservedState()
        }
    }

    func refreshCalendars() {
        perform { token in
            guard self.isCurrent(token) else { return }
            await self.refreshObservedState()
        }
    }

    func checkScreenRecording() {
        perform { token in
            let allowed = await self.verifyScreenRecording()
            guard self.isCurrent(token) else { return }
            self.screenCaptureVerified = allowed
            self.status = allowed ? "Screen and system audio access checked." : "Allow Reel in Screen & System Audio Recording, then check again. macOS may require you to quit and reopen Reel."
        }
    }

    func requestAccessibility() {
        guard active else { return }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        openSettings("Privacy_Accessibility")
        accessibilityAllowed = AXIsProcessTrusted()
    }

    func openSettings(_ pane: String) {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") else { return }
        NSWorkspace.shared.open(url)
    }

    func openCalendar() {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.iCal") {
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    func openChrome() {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") {
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    func monitorForeground() async {
        while active && !Task.isCancelled {
            if NSApp.isActive { await refreshObservedState() }
            do { try await Task.sleep(for: .seconds(2)) }
            catch { return }
        }
    }

    func complete() {
        guard participantConsent, !busy, active else { return }
        perform { token in
            let owner = await self.currentOwner()
            let scope = self.currentScope()
            let accountGeneration = AppModel.shared.accountGeneration
            let includedCalendarIDs = self.observedCalendarIDs ?? []
            guard self.isCurrent(token), self.participantConsent else { return }
            await self.refreshObservedState()
            guard self.isCurrent(token), self.participantConsent else { return }
            guard self.readiness.isReady else {
                self.status = "A setup requirement changed. Check the steps above before completing setup."
                return
            }
            await self.joining.refresh()
            let currentOwner = await self.currentOwner()
            guard self.isCurrent(token), self.participantConsent,
                  currentOwner == owner, self.currentScope() == scope,
                  AppModel.shared.accountGeneration == accountGeneration,
                  AppModel.shared.phase == .idle else {
                if self.active { self.status = "Your account, calendars or recording state changed. Review setup and try again." }
                return
            }
            // Verify actual capture access after the potentially slow cloud/calendar refresh.
            let screenAllowed = await self.verifyScreenRecording()
            guard self.isCurrent(token) else { return }
            self.screenCaptureVerified = screenAllowed
            guard screenAllowed else {
                self.step = 1
                self.status = "Allow Reel in System Settings → Privacy & Security → Screen & System Audio Recording, then check again. macOS may require you to quit and reopen Reel."
                return
            }
            // Re-read non-prompting checks after the capture permission check.
            await self.refreshObservedState()
            let finalOwner = await self.currentOwner()
            guard self.isCurrent(token), self.participantConsent, self.readiness.isReady,
                  finalOwner == owner, self.currentScope() == scope,
                  self.observedCalendarIDs == includedCalendarIDs,
                  AppModel.shared.accountGeneration == accountGeneration,
                  AppModel.shared.phase == .idle else { return }
            guard self.joining.completeSetup(expectedOwner: owner, expectedGeneration: accountGeneration,
                selectedCalendarIDs: scope.ids, useAllCalendars: scope.useAll,
                includedCalendarIDs: includedCalendarIDs, consentConfirmed: self.participantConsent) else {
                self.status = "Calendar refresh or account state changed. Wait a moment, then try Complete setup again."
                return
            }
            self.enabled = self.joining.autoJoin
            self.completed = true
        }
    }

    private func perform(_ operation: @escaping (UUID) async -> Void) {
        guard active, !busy else { return }
        let token = UUID()
        generation = token
        busy = true
        status = ""
        pendingAction = Task {
            await operation(token)
            guard self.isCurrent(token) else { return }
            self.busy = false
            self.pendingAction = nil
        }
    }

    private func isCurrent(_ token: UUID) -> Bool {
        active && generation == token && !Task.isCancelled
    }

    private func currentOwner() async -> String {
        await CloudAuth.shared.current?.userID ?? "local:\(getuid())"
    }

    private func currentScope() -> Scope {
        let ids = Set(OrganizationState.defaults.stringArray(forKey: "meetingCalendar.selectedIDs") ?? [])
        let all = CalendarSelection.initialMode(
            stored: OrganizationState.defaults.object(forKey: "meetingCalendar.useAll") as? Bool,
            selected: ids).useAll
        return Scope(ids: ids, useAll: all)
    }

    private func refreshObservedState() async {
        let owner = await currentOwner()
        guard active, !Task.isCancelled else { return }
        let scope = currentScope()
        let accountGeneration = AppModel.shared.accountGeneration
        let firstObservation = observedOwner == nil
        if !firstObservation,
           observedOwner != owner || observedScope != scope || observedGeneration != accountGeneration {
            resetForScopeChange()
        }
        observedOwner = owner
        observedGeneration = accountGeneration
        observedScope = scope
        let authorization = EKEventStore.authorizationStatus(for: .event)
        calendarAccessAllowed = authorization == .fullAccess
        calendarNeedsSettings = authorization == .denied || authorization == .restricted || authorization == .writeOnly
        accessibilityAllowed = AXIsProcessTrusted()
        chromeAvailable = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") != nil
        await discovery.refresh(selectedCalendarIDs: scope.ids, useAllCalendars: scope.useAll)
        guard active, !Task.isCancelled, observedOwner == owner, currentScope() == scope,
              AppModel.shared.accountGeneration == accountGeneration else { return }
        calendarCount = discovery.calendars.count
        let included = CalendarSelection.identifiers(available: Set(discovery.calendars.map(\.id)),
            selected: scope.ids, useAll: scope.useAll)
        if let observedCalendarIDs, observedCalendarIDs != included { resetForScopeChange() }
        observedCalendarIDs = included
        selectedCalendarCount = included.count
        meetingCount = discovery.meetings.count
        let standingConsent = joining.hasStandingConsentForCurrentScope &&
            OrganizationState.defaults.string(forKey: "meetingCalendar.standingConsentOwner") == owner
        if firstObservation { participantConsent = standingConsent }
        let alreadyEnabled = joining.autoJoin && standingConsent &&
            calendarAccessAllowed && selectedCalendarCount > 0 && accessibilityAllowed && chromeAvailable
        if enabled && !alreadyEnabled {
            status = "Joining in Chrome is paused or a setup requirement changed. Review setup to continue."
            completed = false
        }
        enabled = alreadyEnabled
    }

    private func resetForScopeChange() {
        participantConsent = false
        enabled = false
        completed = false
        status = "Your account or calendar selection changed. Review and confirm consent again."
    }

    private func verifyScreenRecording() async -> Bool {
        do { _ = try await ScreenCapture.shareableContent(); return true }
        catch { return false }
    }
}
