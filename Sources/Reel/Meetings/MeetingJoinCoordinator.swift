import AppKit
import ApplicationServices
import Combine
import CryptoKit
import ReelCore
import ScreenCaptureKit
import UserNotifications
import os

/// Desktop calendar reminders and local capture respect server-owned cloud occurrences.
@MainActor
final class MeetingJoinCoordinator: ObservableObject {
    static let shared = MeetingJoinCoordinator()
    private let log = Logger(subsystem: Log.subsystem, category: "meeting_join")
    @Published private(set) var meetings: [CalendarMeeting] = []
    @Published var selectedID: String?
    @Published var consent = false {
        didSet { if !consent { joinTask?.cancel() } }
    }
    @Published private(set) var status = ""
    @Published private(set) var busy = false
    @Published private(set) var calendarStatus = "Checking meeting calendars…"
    @Published private(set) var cloudMeetings: [CloudCalendarMeeting] = []
    @Published private(set) var cloudCalendarStatus = "Checking cloud meetings…"
    @Published private(set) var accessibilitySettingsURL: URL?
    @Published var reminders = OrganizationState.defaults.bool(forKey: "meetingCalendar.localReminders") {
        didSet { OrganizationState.defaults.set(reminders, forKey: "meetingCalendar.localReminders"); Task { await refresh() } }
    }
    @Published var autoJoin = OrganizationState.defaults.bool(forKey: "meetingCalendar.localAutoJoin") {
        didSet {
            guard oldValue != autoJoin else { return }
            OrganizationState.defaults.set(autoJoin, forKey: "meetingCalendar.localAutoJoin")
            if !autoJoin { joinTask?.cancel() }
            Task { await refresh() }
        }
    }
    @Published var standingConsent = OrganizationState.defaults.bool(forKey: "meetingCalendar.standingConsent") {
        didSet {
            if standingConsent, let consentOwner {
                OrganizationState.defaults.set(consentOwner, forKey: "meetingCalendar.standingConsentOwner")
            } else if standingConsent { standingConsent = false; return }
            OrganizationState.defaults.set(standingConsent, forKey: "meetingCalendar.standingConsent")
            if !standingConsent { autoJoin = false; joinTask?.cancel() }
        }
    }
    private let discovery = CalendarDiscovery()
    private var loop: Task<Void, Never>?
    private var joinTask: Task<Void, Never>?
    private var captureWatch: Task<Void, Never>?
    private var cloudIDs: [String: String] = [:]
    private var desktopRouting: DesktopCalendarRouting?
    private var routingRevision = 0
    private var scheduled = Set<String>()
    private var schedule = MeetingJoinSchedule()
    private struct RefreshScope: Equatable {
        let generation: UInt64
        let calendarIDs: Set<String>
        let useAll: Bool
    }
    private var refreshTask: (scope: RefreshScope, task: Task<Void, Never>)?
    private var refreshing: Bool { refreshTask != nil }
    private var manualMeetings: [CalendarMeeting] = []
    private var accountIdentity: String?
    private var calendarAccountGeneration: UInt64 = 0
    private var consentOwner: String?
    private let base = CloudConfig.default.meetingServiceURL

    var selected: CalendarMeeting? { visibleMeetings.first { $0.id == selectedID } }

    private var hasCurrentAccount: Bool {
        accountIdentity == AppModel.shared.account?.userID && calendarAccountGeneration == AppModel.shared.accountGeneration
    }
    var visibleMeetings: [CalendarMeeting] { hasCurrentAccount ? meetings : [] }
    var visibleCloudMeetings: [CloudCalendarMeeting] { hasCurrentAccount ? cloudMeetings : [] }
    var visibleCloudCalendarStatus: String {
        hasCurrentAccount ? cloudCalendarStatus : "Checking cloud meetings for this account…"
    }
    var visibleStatus: String { hasCurrentAccount ? status : "" }
    var visibleCalendarStatus: String {
        hasCurrentAccount ? calendarStatus : "Refreshing calendars for this account…"
    }

    /// The guided setup commits only a current, explicit consent decision. A refresh
    /// still in flight must finish first; stale account/scope snapshots never opt in.
    func enableAutomaticJoiningForSetup(expectedOwner: String, selectedCalendarIDs: Set<String>,
                                        useAllCalendars: Bool, consentConfirmed: Bool) -> Bool {
        let ids = Set(OrganizationState.defaults.stringArray(forKey: "meetingCalendar.selectedIDs") ?? [])
        let mode = CalendarSelection.initialMode(
            stored: OrganizationState.defaults.object(forKey: "meetingCalendar.useAll") as? Bool, selected: ids)
        let appOwner = AppModel.shared.account?.userID ?? "local:\(getuid())"
        guard consentConfirmed, !refreshing, consentOwner == expectedOwner,
              appOwner == expectedOwner, accountIdentity == AppModel.shared.account?.userID,
              ids == selectedCalendarIDs, mode.useAll == useAllCalendars,
              AppModel.shared.phase == .idle else { return false }
        standingConsent = true
        guard standingConsent,
              OrganizationState.defaults.string(forKey: "meetingCalendar.standingConsentOwner") == expectedOwner else { return false }
        autoJoin = true
        return autoJoin && standingConsent
    }

    func start() {
        guard loop == nil else { return }
        loop = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: .seconds(20))
            }
        }
    }

    func refresh() async {
        if let refreshTask {
            await refreshTask.task.value
            if !Task.isCancelled, refreshTask.scope != refreshScope { await refresh() }
            return
        }
        let scope = refreshScope
        let task = Task {
            defer { self.refreshTask = nil }
            await self.reloadCalendars(scope: scope)
        }
        refreshTask = (scope, task)
        await task.value
        if !Task.isCancelled, scope != refreshScope { await refresh() }
    }

    private var refreshScope: RefreshScope {
        let ids = Set(OrganizationState.defaults.stringArray(forKey: "meetingCalendar.selectedIDs") ?? [])
        let mode = CalendarSelection.initialMode(
            stored: OrganizationState.defaults.object(forKey: "meetingCalendar.useAll") as? Bool, selected: ids)
        return RefreshScope(generation: AppModel.shared.accountGeneration, calendarIDs: ids, useAll: mode.useAll)
    }

    private func reloadCalendars(scope: RefreshScope) async {
        let owner = await CloudAuth.shared.current?.userID
        guard refreshScope == scope, AppModel.shared.account?.userID == owner else { return }
        let currentConsentOwner = owner ?? "local:\(getuid())"
        consentOwner = currentConsentOwner
        if OrganizationState.defaults.string(forKey: "meetingCalendar.standingConsentOwner") != currentConsentOwner {
            standingConsent = false; autoJoin = false
        }
        if owner != accountIdentity || calendarAccountGeneration != scope.generation {
            joinTask?.cancel(); selectedID = nil; consent = false; manualMeetings = []; meetings = []; cloudMeetings = []
            cloudCalendarStatus = "Checking cloud meetings…"
            status = ""; accessibilitySettingsURL = nil
            if accountIdentity != nil, owner != accountIdentity {
                autoJoin = false
                standingConsent = false
            }
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: Array(scheduled))
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: Array(scheduled))
            scheduled = []; schedule.reset(); cloudIDs = [:]; desktopRouting = nil
            routingRevision += 1; accountIdentity = owner; calendarAccountGeneration = scope.generation
        }
        let ids = scope.calendarIDs
        let storedMode = OrganizationState.defaults.object(forKey: "meetingCalendar.useAll") as? Bool
        let mode = CalendarSelection.initialMode(stored: storedMode, selected: ids)
        if storedMode == nil {
            OrganizationState.defaults.set(mode.useAll, forKey: "meetingCalendar.useAll")
            // Earlier cloud-only consent did not cover all local desktop calendars.
            if mode.expandsLegacyScope { standingConsent = false }
        }
        let useAll = mode.useAll
        // Never retain another refresh/account's authority while a routing request is pending.
        desktopRouting = nil; cloudIDs = [:]
        await discovery.refresh(selectedCalendarIDs: ids, useAllCalendars: useAll)
        guard await CloudAuth.shared.current?.userID == owner, refreshScope == scope else { return }
        var found = discovery.meetings + manualMeetings
        var cloudFound: [CloudCalendarMeeting] = []
        var cloudFailure = false
        if let session = await CloudAuth.shared.current {
            guard session.userID == owner else { return }
            do {
                let current = try await CloudAuth.shared.validSession()
                guard current.userID == session.userID else { return }
                var request = URLRequest(url: base.appendingPathComponent("calendar/desktop"), timeoutInterval: 15)
                request.setValue("Bearer \(current.idToken)", forHTTPHeaderField: "Authorization")
                let (data, response) = try await URLSession.shared.data(for: request, delegate: DesktopCalendarRedirectBlocker())
                guard await CloudAuth.shared.current?.userID == current.userID, refreshScope == scope else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200,
                   let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let events = body["events"] as? [[String: Any]],
                   let routing = DesktopCalendarRouting(payload: body, now: Date()) {
                    desktopRouting = routing; routingRevision += 1
                    cloudFound = routing.cloudMeetings
                    for event in events {
                        guard let id = event["id"] as? String, let title = event["title"] as? String,
                              let start = Self.date(event["start"]), let end = Self.date(event["end"]),
                              let raw = event["join_url"] as? String, let link = MeetingLinkParser.parse(raw) else { continue }
                        var meeting = CalendarMeeting(externalID: id, calendarID: "reel-cloud", title: title,
                            start: start, end: end, joinURL: link.url, platform: link.platform,
                            attendeeEmails: event["attendees"] as? [String] ?? [])
                        meeting.deliveryCalendar = discovery.meetings.first(where: { Self.key($0) == Self.key(meeting) })?.deliveryCalendar
                            ?? MeetingCalendarReference(legacyOccurrenceID: id, occurrenceStart: ISO8601DateFormatter().string(from: start))
                        cloudIDs[id] = meeting.id
                        found.insert(meeting, at: 0)
                    }
                } else { cloudFailure = true }
            } catch { cloudFailure = true }
        } else {
            // There is no cloud account to own local-only calendar occurrences.
            desktopRouting = DesktopCalendarRouting(payload: ["events": []], now: Date())
            routingRevision += 1
        }
        guard await CloudAuth.shared.current?.userID == owner, refreshScope == scope else { return }
        found = found.filter { DesktopCalendarRouting.allowsLocal($0, routing: desktopRouting) }
        cloudMeetings = cloudFound.sorted { $0.start < $1.start }
        if owner == nil { cloudCalendarStatus = "Sign in to see your cloud meetings." }
        else if cloudFailure { cloudCalendarStatus = "Cloud meetings are unavailable. Check your connection and refresh." }
        else if cloudFound.isEmpty { cloudCalendarStatus = "No upcoming or ongoing cloud meetings found." }
        else { cloudCalendarStatus = "\(cloudFound.count) upcoming or ongoing cloud \(cloudFound.count == 1 ? "meeting" : "meetings")." }
        var seen = Set<String>()
        meetings = found.filter { $0.end > Date() && seen.insert(Self.key($0)).inserted }.sorted { $0.start < $1.start }
        if let selectedID, !meetings.contains(where: { $0.id == selectedID }) {
            joinTask?.cancel(); self.selectedID = nil; consent = false
        }
        await updateReminders()
        guard await CloudAuth.shared.current?.userID == owner, refreshScope == scope else { return }
        if cloudFailure { calendarStatus = "Cloud routing could not be verified. Meet and Teams desktop joining are paused; local Zoom meetings remain available. Check your connection and Reel sign-in." }
        else if !autoJoin { calendarStatus = "Automatic joining is off. Enable it below after connecting your desktop calendars and confirming participant consent." }
        else if !standingConsent { calendarStatus = "Automatic joining needs participant consent for this Reel account." }
        else if !AXIsProcessTrusted() { calendarStatus = "Automatic joining is blocked: allow Reel in System Settings → Privacy & Security → Accessibility." }
        else if CalendarSelection.identifiers(available: Set(discovery.calendars.map(\.id)), selected: ids, useAll: useAll).isEmpty && meetings.allSatisfy({ $0.calendarID != "reel-cloud" }) { calendarStatus = discovery.authorizationMessage }
        else { calendarStatus = "Automatic joining is on. Reel checks every 20 seconds while this Mac is awake. \(meetings.filter { $0.calendarID != "manual" }.count) upcoming or ongoing meetings found." }
        if autoJoin && standingConsent && !busy && AppModel.shared.phase == .idle {
            if let due = meetings.first(where: {
                $0.calendarID != "manual" && schedule.shouldAttempt(key: Self.key($0), start: $0.start, end: $0.end, now: Date()) && AppModel.shared.existingMeeting(forOccurrence: $0.id) == nil
            }) {
                schedule.begin(key: Self.key(due), now: Date())
                join(due, confirmed: true, includeMicrophone: false, automatic: true)
            }
        }
    }

    func select(id: String) async {
        await refresh()
        selectedID = cloudIDs[id] ?? meetings.first { Self.key($0) == id || $0.id == id }?.id
        consent = false
    }

    func prepareLink(_ raw: String) {
        guard let link = MeetingLinkParser.parse(raw) else { status = "Use a direct Google Meet, Zoom or Teams meeting link."; return }
        let meeting = CalendarMeeting(externalID: UUID().uuidString, calendarID: "manual", title: "Meeting",
            start: Date(), end: Date().addingTimeInterval(3 * 3600), joinURL: link.url, platform: link.platform)
        manualMeetings.append(meeting); meetings.append(meeting); selectedID = meeting.id; consent = false
    }

    func join(_ meeting: CalendarMeeting, confirmed: Bool, includeMicrophone: Bool = true, automatic: Bool = false) {
        guard confirmed, !busy, AppModel.shared.phase == .idle else { return }
        guard AppModel.shared.existingMeeting(forOccurrence: meeting.id) == nil else { status = "This meeting is already in your Reel library."; return }
        busy = true; accessibilitySettingsURL = nil; status = "Opening meeting"
        log.notice("Meeting entry started; automatic=\(automatic, privacy: .public)")
        joinTask = Task {
            var captureHandedOff = false
            var joinedWindowID: CGWindowID?
            var retryable = false
            defer {
                if !captureHandedOff, let joinedWindowID { LocalMeetingJoin.closeOwned(windowID: joinedWindowID) }
                if automatic && !captureHandedOff { schedule.finish(key: Self.key(meeting), now: Date(), retryable: retryable) }
                busy = false; joinTask = nil
            }
            let owner = await CloudAuth.shared.current?.userID
            do {
                guard owner == accountIdentity,
                      consentOwner == (owner ?? "local:\(getuid())") else {
                    consent = false
                    status = "Your account changed. Refresh meetings and confirm consent again."
                    return
                }
                if meeting.platform == .teams || meeting.platform == .googleMeet || meeting.calendarID == "manual" {
                    let previousRevision = routingRevision
                    // Recheck stale selections, notification links and manual objects before any AX action.
                    // busy prevents refresh from recursively scheduling another automatic join.
                    await refresh()
                    guard await CloudAuth.shared.current?.userID == owner,
                          AppModel.shared.account?.userID == owner, accountIdentity == owner else {
                        status = "Your account changed. Refresh meetings and confirm consent again."
                        return
                    }
                    let routing = routingRevision != previousRevision ? desktopRouting : nil
                    guard routing != nil || meeting.platform == .zoom else {
                        status = "Cloud routing could not be verified. Refresh meetings before joining Meet or Teams on this Mac."
                        return
                    }
                    guard DesktopCalendarRouting.allowsLocal(meeting, routing: routing) else {
                        status = "This meeting occurrence is handled by the cloud bot. Desktop joining is paused for this occurrence."
                        return
                    }
                }
                try Task.checkCancellation()
                if automatic {
                    guard AXIsProcessTrusted() else { throw LocalMeetingJoin.JoinError.accessibilityPermissionRequired }
                    // Ask the API that captures; CG preflight can disagree with it.
                    do { _ = try await ScreenCapture.shareableContent() }
                    catch {
                        retryable = true
                        status = "Automatic recording cannot read screen content. Check Reel’s Screen & System Audio Recording access. Reel will retry within five minutes."
                        return
                    }
                }
                await markCloud(meeting, state: "requesting_entry", expectedOwner: owner)
                try Task.checkCancellation()
                let result = try await LocalMeetingJoin.join(url: meeting.joinURL, consentConfirmed: true) { self.status = $0 }
                if case .joined(let id) = result { joinedWindowID = id }
                try Task.checkCancellation()
                guard AppModel.shared.account?.userID == owner, AppModel.shared.phase == .idle else { status = "Account or recording changed. Start again."; return }
                switch result {
                case .joined(let id):
                    let content = try await ScreenCapture.shareableContent()
                    try Task.checkCancellation()
                    guard await CloudAuth.shared.current?.userID == owner, AppModel.shared.phase == .idle else { return }
                    guard let window = content.windows.first(where: { $0.windowID == id }) else {
                        status = "The meeting window is unavailable. Choose it in Reel."
                        await markCloud(meeting, state: "failed", expectedOwner: owner)
                        return
                    }
                    let model = AppModel.shared
                    model.meetingMode = true; model.meetingTitle = meeting.title
                    model.meetingAttendees = meeting.attendeeEmails.joined(separator: ", ")
                    model.meetingCalendarOccurrenceID = meeting.id
                    model.meetingCalendarReference = meeting.deliveryCalendar
                    model.meetingMicrophoneEnabled = includeMicrophone
                    guard RecorderController.shared.start(window: window, focusWindowOnStart: false, authorization: {
                        self.accountIdentity == owner && model.account?.userID == owner &&
                        (!automatic || (self.autoJoin && self.standingConsent))
                    }) else {
                        status = "A previous recording is still finishing setup cleanup. Try again shortly."
                        retryable = automatic
                        await markCloud(meeting, state: "failed", expectedOwner: owner)
                        return
                    }
                    captureHandedOff = true
                    watchCapture(meeting, windowID: id, expectedOwner: owner, automatic: automatic)
                    status = "Joined. Starting local meeting capture."
                case .awaitingAdmission:
                    status = "Still waiting for the host. Join manually, then start meeting capture in Reel."
                    await markCloud(meeting, state: "awaiting_admission", expectedOwner: owner)
                case .signInRequired:
                    status = "Sign in to the meeting in Chrome, then try again."
                    await markCloud(meeting, state: "failed", expectedOwner: owner)
                case .manualInteractionRequired:
                    status = "Finish joining in Chrome, then start meeting capture in Reel."
                    await markCloud(meeting, state: "failed", expectedOwner: owner)
                case .timedOut:
                    status = "Meeting entry was not confirmed. Join manually and choose the meeting window in Reel."
                    await markCloud(meeting, state: "failed", expectedOwner: owner)
                }
            } catch is CancellationError { status = "Meeting setup cancelled." }
            catch {
                if let joinError = error as? LocalMeetingJoin.JoinError {
                    switch joinError {
                    // No meeting URL has been opened when dedicated-window setup fails,
                    // so the existing bounded scheduler can safely retry it.
                    case .accessibilityPermissionRequired, .chromeUnavailable, .dedicatedWindowUnavailable: retryable = true
                    default: break
                    }
                }
                status = error.localizedDescription
                if automatic && retryable { status += " Reel retries within the first five minutes while attempts remain (up to three attempts)." }
                accessibilitySettingsURL = (error as? LocalMeetingJoin.JoinError)?.settingsURL
                let failure = (error as? LocalMeetingJoin.JoinError).map { String(describing: $0) } ?? "unexpected_error"
                log.error("Meeting entry failed; automatic=\(automatic, privacy: .public) retryable=\(retryable, privacy: .public): \(failure, privacy: .public)")
                await markCloud(meeting, state: "failed", expectedOwner: owner)
            }
        }
    }

    func cancel() { joinTask?.cancel() }

    private func markCloud(_ meeting: CalendarMeeting, state: String, expectedOwner: String?) async {
        guard let id = cloudIDs.first(where: { $0.value == meeting.id })?.key,
              let owner = await CloudAuth.shared.current, owner.userID == expectedOwner else { return }
        do {
            try Task.checkCancellation()
            let session = try await CloudAuth.shared.validSession()
            try Task.checkCancellation()
            guard owner.userID == session.userID,
                  await CloudAuth.shared.current?.userID == expectedOwner else { return }
            var request = URLRequest(url: base.appendingPathComponent("calendar/desktop/\(id)/state"), timeoutInterval: 10)
            request.httpMethod = "POST"
            request.setValue("Bearer \(session.idToken)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["state": state, "participant_consent_attested": true])
            _ = try await URLSession.shared.data(for: request, delegate: DesktopCalendarRedirectBlocker())
        } catch { /* Local capture remains available if metadata sync is offline. */ }
    }

    private func captureAuthorized(expectedOwner: String?, automatic: Bool) async -> Bool {
        guard await CloudAuth.shared.current?.userID == expectedOwner,
              AppModel.shared.account?.userID == expectedOwner else { return false }
        return !automatic || (autoJoin && standingConsent)
    }

    @discardableResult
    private func stopRevokedCaptureIfOwned(_ meeting: CalendarMeeting, windowID: CGWindowID,
                                           expectedOwner: String?, automatic: Bool,
                                           authorizationValid: Bool) -> Bool {
        guard AppModel.shared.phase == .recording || AppModel.shared.phase == .paused,
              let recordingID = RecorderController.shared.currentRecordingID,
              let recording = AppModel.shared.recording(id: recordingID),
              MeetingCapturePolicy.shouldStopOnRevocation(
                automatic: automatic, authorizationValid: authorizationValid,
                recording: recording, occurrenceID: meeting.id, ownerUserID: expectedOwner) else { return false }
        RecorderController.shared.stop() // Finishes and saves the matching local recording.
        LocalMeetingJoin.closeOwned(windowID: windowID)
        return true
    }

    private func watchCapture(_ meeting: CalendarMeeting, windowID: CGWindowID, expectedOwner: String?, automatic: Bool) {
        captureWatch?.cancel()
        captureWatch = Task {
            defer { LocalMeetingJoin.forget(windowID: windowID) }
            var captureStarted = false
            defer {
                if !captureStarted {
                    LocalMeetingJoin.closeOwned(windowID: windowID)
                    if automatic { schedule.finish(key: Self.key(meeting), now: Date(), retryable: false) }
                }
            }
            while !Task.isCancelled {
                let authorized = await captureAuthorized(expectedOwner: expectedOwner, automatic: automatic)
                if !authorized {
                    status = "Meeting setup cancelled because the account or automatic-recording consent changed."
                    if !automatic { return }
                    if stopRevokedCaptureIfOwned(meeting, windowID: windowID, expectedOwner: expectedOwner,
                                                 automatic: automatic, authorizationValid: false) { return }
                    if AppModel.shared.phase == .recording || AppModel.shared.phase == .paused { return }
                    // Preparation can cross its final authorization check just as consent changes.
                    // Keep watching until it becomes idle or a matching recording can be stopped.
                    if AppModel.shared.phase == .idle { return }
                    try? await Task.sleep(for: .milliseconds(100))
                    continue
                }
                if AppModel.shared.phase == .idle {
                    if automatic { schedule.finish(key: Self.key(meeting), now: Date(), retryable: false) }
                    status = AppModel.shared.lastError ?? "Capture did not start. Check Reel's recording permissions."
                    await markCloud(meeting, state: "failed", expectedOwner: expectedOwner)
                    return
                }
                if AppModel.shared.phase == .recording || AppModel.shared.phase == .paused { break }
                try? await Task.sleep(for: .milliseconds(100))
            }
            guard !Task.isCancelled,
                  let recordingID = RecorderController.shared.currentRecordingID,
                  let recording = AppModel.shared.recording(id: recordingID),
                  recording.meeting?.calendarOccurrenceID == meeting.id,
                  recording.meeting?.ownerUserID == expectedOwner,
                  AppModel.shared.phase == .recording || AppModel.shared.phase == .paused else { return }
            guard await captureAuthorized(expectedOwner: expectedOwner, automatic: automatic) else {
                status = "Meeting setup cancelled because the account or automatic-recording consent changed."
                _ = stopRevokedCaptureIfOwned(meeting, windowID: windowID, expectedOwner: expectedOwner,
                                              automatic: automatic, authorizationValid: false)
                return
            }
            captureStarted = true
            if automatic { schedule.complete(key: Self.key(meeting)) }
            // Metadata must not delay the local consent/account watcher.
            let joinedUpdate = Task { await markCloud(meeting, state: "joined", expectedOwner: expectedOwner) }
            defer { joinedUpdate.cancel() }
            status = "Joined and recording the meeting window locally."
            let deadline = min(meeting.end.addingTimeInterval(300), Date().addingTimeInterval(3 * 3600))
            var watchdog = MeetingCallWatchdog()
            while !Task.isCancelled, RecorderController.shared.currentRecordingID == recordingID,
                  AppModel.shared.phase == .recording || AppModel.shared.phase == .paused {
                let authorized = await captureAuthorized(expectedOwner: expectedOwner, automatic: automatic)
                if !authorized {
                    status = "Meeting setup cancelled because the account or automatic-recording consent changed."
                    _ = stopRevokedCaptureIfOwned(meeting, windowID: windowID, expectedOwner: expectedOwner,
                                                  automatic: automatic, authorizationValid: false)
                    return
                }
                let active = LocalMeetingJoin.isStillInCall(windowID: windowID)
                let now = Date()
                if now >= deadline || watchdog.shouldStop(active: active, now: now) {
                    RecorderController.shared.stop()
                    if automatic { LocalMeetingJoin.closeOwned(windowID: windowID) }
                    // Capture is already stopped. Preserve joined→completed ordering
                    // without making local consent monitoring wait on the network.
                    await joinedUpdate.value
                    await markCloud(meeting, state: "completed", expectedOwner: expectedOwner)
                    return
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func updateReminders() async {
        let center = UNUserNotificationCenter.current()
        let upcoming = reminders ? Array(meetings.prefix(32)) : []
        let wanted = Set(upcoming.map { "reel-meeting-" + Self.key($0) })
        center.removePendingNotificationRequests(withIdentifiers: Array(scheduled.subtracting(wanted)))
        for meeting in upcoming {
            let id = "reel-meeting-" + Self.key(meeting)
            guard !scheduled.contains(id), schedule.shouldAttempt(key: Self.key(meeting), start: meeting.start, end: meeting.end, now: meeting.start) else { continue }
            var url = URLComponents(); url.scheme = "reel"; url.host = "join-meeting"
            url.queryItems = [URLQueryItem(name: "id", value: Self.key(meeting))]
            let content = UNMutableNotificationContent()
            content.title = "Meeting detected. Join and record?"; content.body = meeting.title
            content.userInfo = ["url": url.url!.absoluteString]
            let trigger: UNNotificationTrigger? = meeting.start > Date()
                ? UNCalendarNotificationTrigger(dateMatching: Calendar.current.dateComponents([.year,.month,.day,.hour,.minute,.second], from: meeting.start), repeats: false) : nil
            try? await center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
        }
        scheduled = wanted
    }

    private static func date(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions.insert(.withFractionalSeconds)
        return formatter.date(from: text)
    }

    private static func key(_ meeting: CalendarMeeting) -> String {
        let input = meeting.occurrenceIdentity
        return SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

private final class DesktopCalendarRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
