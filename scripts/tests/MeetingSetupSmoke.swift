import AppKit
import EventKit
import ReelCore

// Compile this file with MeetingSetupModel.swift and CalendarDiscovery.swift. The local names below
// replace only its effectful dependencies. Run scripts/test-meeting-setup.sh.
// No TCC requests, calendar queries, Keychain access, launches or recordings occur.

@MainActor final class Suspension {
    var held = false
    var entered = 0
    private var waiting: CheckedContinuation<Void, Never>?

    func pauseIfHeld() async {
        entered += 1
        if held { await withCheckedContinuation { waiting = $0 } }
    }

    func release() {
        held = false
        let continuation = waiting
        waiting = nil
        continuation?.resume()
    }
}

// Module-local shadows leave the actual EventKit and Accessibility permissions alone.
@MainActor final class EKEventStore {
    struct Source {
        let title: String
        let sourceIdentifier: String
    }
    struct Calendar {
        let calendarIdentifier: String
        let title: String
        let source: Source
    }
    static var authorization: EKAuthorizationStatus = .fullAccess
    static var accessRequests = 0
    static var predicates: [[String]] = []
    static var queries: [[String]] = []
    static let fixtureCalendars = [
        Calendar(calendarIdentifier: "calendar-a", title: "Fixture A",
                 source: Source(title: "Fixture", sourceIdentifier: "account-a")),
        Calendar(calendarIdentifier: "calendar-b", title: "Fixture B",
                 source: Source(title: "Fixture", sourceIdentifier: "account-a")),
    ]
    static var available = fixtureCalendars

    static func authorizationStatus(for type: EKEntityType) -> EKAuthorizationStatus { authorization }

    func requestFullAccessToEvents() async throws -> Bool {
        Self.accessRequests += 1
        Self.authorization = .fullAccess
        return true
    }

    func calendars(for type: EKEntityType) -> [Calendar] { Self.available }

    func predicateForEvents(withStart start: Date, end: Date, calendars: [Calendar]) -> [String] {
        let ids = calendars.map(\.calendarIdentifier)
        Self.predicates.append(ids)
        return ids
    }

    func events(matching predicate: [String]) -> [EKEvent] {
        Self.queries.append(predicate)
        return []
    }
}
@MainActor var accessibilityGranted = true
@MainActor func AXIsProcessTrusted() -> Bool { accessibilityGranted }
@MainActor func AXIsProcessTrustedWithOptions(_ options: CFDictionary?) -> Bool {
    fatalError("Smoke tests must not request Accessibility access")
}

actor CloudAuth {
    struct Session { let userID: String }
    static let shared = CloudAuth()
    var current: Session? = Session(userID: "owner-a")
    func setOwner(_ owner: String?) { current = owner.map { Session(userID: $0) } }
}

@MainActor final class AppModel {
    enum Phase { case idle, recording }
    static let shared = AppModel()
    var phase = Phase.idle
    var accountGeneration: UInt64 = 0
}

@MainActor enum ScreenCapture {
    enum Denied: Error { case fixture }
    static var gate = Suspension()
    static var allowed = true
    static func shareableContent() async throws -> Bool {
        await gate.pauseIfHeld()
        if !allowed { throw Denied.fixture }
        return true
    }
}

@MainActor final class MeetingJoinCoordinator {
    struct Commit {
        let owner: String
        let ids: Set<String>
        let included: Set<String>
        let consent: Bool
    }
    static let shared = MeetingJoinCoordinator()
    var gate = Suspension()
    var standingConsent = false
    var autoJoin = false
    var setupWillEnableJoining = true
    var hasStandingConsentForCurrentScope: Bool {
        let defaults = OrganizationState.defaults
        return standingConsent && CalendarSelection.load(from: defaults).savedIDs != nil &&
            defaults.string(forKey: "meetingCalendar.standingConsentOwner") == "owner-a"
    }
    var acceptsCommit = true
    var commits: [Commit] = []
    func refresh() async { await gate.pauseIfHeld() }
    // Deliberately permissive: a stale/cancelled model must never reach this boundary.
    func completeSetup(expectedOwner: String, expectedGeneration: UInt64,
                       selectedCalendarIDs: Set<String>,
                       includedCalendarIDs: Set<String>, consentConfirmed: Bool) -> Bool {
        commits.append(Commit(owner: expectedOwner, ids: selectedCalendarIDs,
                              included: includedCalendarIDs, consent: consentConfirmed))
        if acceptsCommit { autoJoin = setupWillEnableJoining }
        return acceptsCommit
    }
}

@MainActor @main struct MeetingSetupSmoke {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }
    static var cases = 0
    static let joining = MeetingJoinCoordinator.shared
    static var defaults: [String: Any] = [:]

    static func main() async {
        let previous = OrganizationState.defaults.volatileDomain(forName: UserDefaults.argumentDomain)
        defer { OrganizationState.defaults.setVolatileDomain(previous, forName: UserDefaults.argumentDomain) }
        do {
            try require(NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") != nil,
                        "Fixture requires installed Chrome (nothing will launch)")
            try await observationDoesNotConsent()
            try await unconfirmedCalendarScopeDoesNotCountAsSelected()
            try await savedCalendarScopeIsTheOnlyScopeQueried()
            try await initialConsentOwnership()
            try await alreadyEnabledSetup()
            try await validCommitAndGuards()
            try await completedSetupKeepsPriorPause()
            try await invalidInitialRequirements()
            try await cancelDuringScreenCheck()
            try await cancelDuringEnableScreenCheck()
            try await raceAtCoordinator("close") { $0.cancelPendingActions() }
            try await raceAtCoordinator("account switch") { _ in await CloudAuth.shared.setOwner("owner-b") }
            try await raceAtCoordinator("account switched and returned") { _ in AppModel.shared.accountGeneration += 2 }
            try await raceAtCoordinator("calendar scope change") { _ in setScope(["calendar-b"], all: false) }
            try await raceAtCoordinator("all-calendars mode change") { _ in setScope(["calendar-a"], all: true) }
            try await raceAtCoordinator("calendar revoke") { _ in EKEventStore.authorization = .denied }
            try await raceAtCoordinator("accessibility revoke") { _ in accessibilityGranted = false }
            try await raceAtCoordinator("screen revoke") { _ in ScreenCapture.allowed = false }
            try await raceAtCoordinator("recording starts") { _ in AppModel.shared.phase = .recording }
            try await raceAtCoordinator("consent withdrawn") { $0.participantConsent = false }
            try await raceAtScreen("account switch") { _ in await CloudAuth.shared.setOwner("owner-b") }
            try await raceAtScreen("calendar scope change") { _ in setScope(["calendar-b"], all: false) }
            try await raceAtScreen("calendar revoke") { _ in EKEventStore.authorization = .denied }
            try await raceAtScreen("accessibility revoke") { _ in accessibilityGranted = false }
            try await raceAtScreen("recording starts") { _ in AppModel.shared.phase = .recording }
            try await raceAtScreen("consent withdrawn") { $0.participantConsent = false }
            print("MeetingSetup smoke passed: \(cases) cases; actual model, suspended async boundaries, in-memory commits only.")
        } catch {
            FileHandle.standardError.write(Data("MeetingSetup smoke FAILED: \(error)\n".utf8))
            exit(1)
        }
    }

    static func fresh() async -> MeetingSetupModel {
        defaults = ["meetingCalendar.selectedIDs": ["calendar-a"], "meetingCalendar.useAll": false,
                    "meetingCalendar.standingConsentOwner": ""]
        applyDefaults()
        await CloudAuth.shared.setOwner("owner-a")
        AppModel.shared.phase = .idle
        AppModel.shared.accountGeneration = 0
        EKEventStore.authorization = .fullAccess
        EKEventStore.accessRequests = 0
        EKEventStore.predicates = []
        EKEventStore.queries = []
        EKEventStore.available = EKEventStore.fixtureCalendars
        accessibilityGranted = true
        ScreenCapture.allowed = true
        ScreenCapture.gate = Suspension()
        joining.gate = Suspension()
        joining.standingConsent = false
        joining.autoJoin = false
        joining.setupWillEnableJoining = true
        joining.acceptsCommit = true
        joining.commits = []
        return MeetingSetupModel()
    }

    static func ready() async throws -> MeetingSetupModel {
        let model = await fresh()
        model.refreshCalendars()
        try await settled(model)
        model.checkScreenRecording()
        try await settled(model)
        try require(model.readiness.isReady, "Ready fixture did not meet setup requirements")
        model.participantConsent = true
        return model
    }

    static func observationDoesNotConsent() async throws {
        let model = await fresh()
        for _ in 0..<3 { model.refreshCalendars(); try await settled(model) }
        try require(!model.participantConsent && !model.enabled && joining.commits.isEmpty,
                    "Observing granted permissions granted consent/enabled joining")
        try require(ScreenCapture.gate.entered == 0, "Observation requested screen capture access")
        passed("observation does not grant consent or request capture")
    }

    static func unconfirmedCalendarScopeDoesNotCountAsSelected() async throws {
        for previousAll in [false, true] {
            let model = await fresh()
            if previousAll {
                setScope(["calendar-a"], all: true)
            } else {
                defaults["meetingCalendar.useAll"] = "legacy missing Bool"
                defaults["meetingCalendar.selectedIDs"] = [String]()
                applyDefaults()
            }
            EKEventStore.authorization = .notDetermined
            model.connectCalendars()
            try await settled(model)
            model.refreshCalendars()
            try await settled(model)
            try require(model.calendars.count == 2 && model.selectedCalendarCount == 0,
                        "Discovery counted available calendars before an explicit selection")
            try require(EKEventStore.accessRequests == 1 && EKEventStore.predicates.isEmpty && EKEventStore.queries.isEmpty,
                        "Connecting or refreshing queried events before an explicit selection")
            model.checkScreenRecording()
            try await settled(model)
            try require(model.screenCaptureVerified && model.readiness.blockers == [.calendarSelection],
                        "An unsaved calendar scope incorrectly blocked the recording permission check or passed setup readiness")
            model.participantConsent = true
            model.complete()
            try await settled(model)
            try require(joining.commits.isEmpty, "Consent committed without an explicit calendar selection")
        }
        passed("fresh and former all-calendar setup remain unselected and recording access can be checked")
    }

    static func savedCalendarScopeIsTheOnlyScopeQueried() async throws {
        let model = await fresh()
        model.refreshCalendars()
        try await settled(model)
        EKEventStore.available.append(.init(calendarIdentifier: "calendar-new", title: "New calendar",
                                           source: .init(title: "Other account", sourceIdentifier: "account-b")))
        model.refreshCalendars()
        try await settled(model)
        try require(model.calendars.count == 3 && model.selectedCalendarCount == 1,
                    "A newly discovered calendar was selected automatically")
        try require(EKEventStore.predicates == [["calendar-a"], ["calendar-a"]] &&
                    EKEventStore.queries == EKEventStore.predicates,
                    "An event query included calendars outside the saved selection")
        setScope([], all: false)
        model.refreshCalendars()
        try await settled(model)
        try require(model.selectedCalendarCount == 0 && EKEventStore.predicates.count == 2 && EKEventStore.queries.count == 2,
                    "Refreshing an explicitly empty selection queried calendar events")
        passed("event predicates contain only saved IDs and an empty save makes no query")
    }

    static func initialConsentOwnership() async throws {
        for (owner, legacy, expected) in [("owner-b", false, false), ("owner-a", true, false), ("owner-a", false, true)] {
            let model = await fresh()
            joining.standingConsent = true
            defaults["meetingCalendar.standingConsentOwner"] = owner
            if legacy {
                // A non-Bool exercises the same `as? Bool == nil` legacy path
                // while masking any lower UserDefaults domains in this process.
                defaults["meetingCalendar.useAll"] = "legacy missing Bool"
                defaults["meetingCalendar.selectedIDs"] = [String]()
            }
            applyDefaults()
            model.refreshCalendars()
            try await settled(model)
            try require(model.participantConsent == expected, "Restored consent from wrong owner or expanded legacy scope")
            try require(joining.commits.isEmpty && ScreenCapture.gate.entered == 0, "Consent restore performed enable/capture")
        }
        passed("standing consent restores only for current owner and unchanged explicit scope")
    }

    static func alreadyEnabledSetup() async throws {
        let model = await fresh()
        joining.standingConsent = true
        joining.autoJoin = true
        defaults["meetingCalendar.standingConsentOwner"] = "owner-a"
        applyDefaults()
        model.refreshCalendars()
        try await settled(model)
        try require(model.enabled, "Existing automatic joining did not show the completed setup")
        try require(joining.commits.isEmpty && ScreenCapture.gate.entered == 0,
                    "Opening completed setup performed enable or requested capture access")
        await CloudAuth.shared.setOwner("owner-b")
        model.refreshCalendars()
        try await settled(model)
        try require(!model.enabled && !model.participantConsent, "Completed setup leaked across accounts")
        passed("completed setup observes the current owner without requesting access")
    }

    static func validCommitAndGuards() async throws {
        let model = try await ready()
        model.participantConsent = false
        model.complete()
        try require(!model.busy && joining.commits.isEmpty, "Unchecked consent entered enable")
        model.participantConsent = true
        joining.gate.held = true
        model.complete()
        try await until("coordinator refresh") { joining.gate.entered == 1 }
        let checksBefore = ScreenCapture.gate.entered
        model.complete()
        try require(joining.gate.entered == 1 && ScreenCapture.gate.entered == checksBefore,
                    "A second enable ran while busy")
        joining.gate.release()
        try await settled(model)
        try require(model.completed && model.enabled && joining.commits.count == 1, "Valid enable did not commit exactly once")
        let commit = joining.commits[0]
        try require(commit.owner == "owner-a" && commit.ids == ["calendar-a"] && commit.included == ["calendar-a"] && commit.consent,
                    "Enable committed a different owner, scope or consent")
        passed("valid explicit consent commits once; unchecked/busy enable is blocked")

        let rejected = try await ready()
        joining.acceptsCommit = false
        rejected.complete()
        try await settled(rejected)
        try require(!rejected.enabled && joining.commits.count == 1, "Rejected coordinator commit reported enabled")
        passed("coordinator refusal does not report enabled")
    }

    static func completedSetupKeepsPriorPause() async throws {
        let model = try await ready()
        joining.setupWillEnableJoining = false
        try require(!model.willEnableJoining, "Review said paused joining would turn on")
        model.complete()
        try await settled(model)
        try require(model.completed && !model.enabled && joining.commits.count == 1,
                    "Completing consent did not preserve the prior pause")
        passed("completed setup preserves a prior pause")
    }

    static func cancelDuringScreenCheck() async throws {
        let model = await fresh()
        ScreenCapture.gate.held = true
        model.checkScreenRecording()
        try await until("explicit screen check") { ScreenCapture.gate.entered == 1 }
        model.cancelPendingActions()
        ScreenCapture.gate.release()
        try await drain()
        try require(!model.busy && !model.screenCaptureVerified && joining.commits.isEmpty,
                    "Closed screen check updated state")
        model.participantConsent = true
        model.complete()
        try await drain()
        try require(joining.commits.isEmpty && !model.busy, "Closed setup accepted a new enable")
        passed("close during explicit capture check discards result and further actions")
    }

    static func invalidInitialRequirements() async throws {
        for name in ["calendar permission", "empty scope", "accessibility", "unverified capture", "recording"] {
            let model = name == "unverified capture" ? await fresh() : try await ready()
            if name == "unverified capture" {
                model.refreshCalendars()
                try await settled(model)
                model.participantConsent = true
            }
            switch name {
            case "calendar permission": EKEventStore.authorization = .denied
            case "empty scope": setScope([], all: false)
            case "accessibility": accessibilityGranted = false
            case "recording": AppModel.shared.phase = .recording
            default: break
            }
            model.complete()
            try await settled(model)
            try require(joining.commits.isEmpty && !model.enabled, "Invalid initial \(name) committed")
            passed("initial \(name) blocks enable")
        }
    }

    static func cancelDuringEnableScreenCheck() async throws {
        try await raceAtScreen("close") { $0.cancelPendingActions() }
    }

    static func raceAtCoordinator(_ name: String, mutate: (MeetingSetupModel) async -> Void) async throws {
        let model = try await ready()
        joining.gate.held = true
        let screenChecks = ScreenCapture.gate.entered
        model.complete()
        try await until("coordinator refresh for \(name)") { joining.gate.entered == 1 }
        try require(ScreenCapture.gate.entered == screenChecks,
                    "Capture access was checked before slow coordinator refresh completed (\(name))")
        await mutate(model)
        joining.gate.release()
        try await settled(model)
        try await drain()
        try require(joining.commits.isEmpty && !model.enabled, "\(name) during coordinator refresh committed")
        if name == "screen revoke" {
            try require(ScreenCapture.gate.entered == screenChecks + 1 && !model.screenCaptureVerified && model.step == 1,
                        "Capture revocation during coordinator wait was not freshly checked")
        }
        passed("\(name) during coordinator wait prevents commit")
    }

    static func raceAtScreen(_ name: String, mutate: (MeetingSetupModel) async -> Void) async throws {
        let model = try await ready()
        ScreenCapture.gate.held = true
        let checks = ScreenCapture.gate.entered
        model.complete()
        try await until("capture verification for \(name)") { ScreenCapture.gate.entered == checks + 1 }
        await mutate(model)
        ScreenCapture.gate.release()
        try await settled(model)
        try await drain()
        try require(joining.commits.isEmpty && !model.enabled, "\(name) during capture verification committed")
        passed("\(name) during capture wait prevents commit")
    }

    static func setScope(_ ids: [String], all: Bool) {
        defaults["meetingCalendar.selectedIDs"] = ids
        defaults["meetingCalendar.useAll"] = all
        applyDefaults()
    }
    static func applyDefaults() {
        OrganizationState.defaults.setVolatileDomain(defaults, forName: UserDefaults.argumentDomain)
    }
    static func settled(_ model: MeetingSetupModel) async throws {
        try await until("setup action completion") { !model.busy }
    }
    static func until(_ description: String, condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !condition() {
            if ContinuousClock.now >= deadline { throw Failure(description: "Timed out: \(description)") }
            try await Task.sleep(for: .milliseconds(1))
        }
    }
    static func drain() async throws {
        // Cancellation deliberately doesn't resume the stubs' continuations. Allow
        // the late dependency result to return before checking for an unsafe commit.
        for _ in 0..<10 { await Task.yield() }
        try await Task.sleep(for: .milliseconds(5))
    }
    static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(description: message) }
    }
    static func passed(_ name: String) { cases += 1; print("PASS \(name)") }
}
