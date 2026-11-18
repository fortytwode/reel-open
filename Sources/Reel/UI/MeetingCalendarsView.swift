import AppKit
import EventKit
import ReelCore
import SwiftUI

/// Explicit setup and visible status for owner-bound local meeting automation.
struct MeetingCalendarsView: View {
    @ObservedObject var model: AppModel
    @StateObject private var discovery = CalendarDiscovery()
    @State private var selectedCalendarIDs: Set<String> = Set(OrganizationState.defaults.stringArray(forKey: Self.selectionKey) ?? [])
    @State private var useAllCalendars = CalendarSelection.initialMode(
        stored: OrganizationState.defaults.object(forKey: "meetingCalendar.useAll") as? Bool,
        selected: Set(OrganizationState.defaults.stringArray(forKey: "meetingCalendar.selectedIDs") ?? [])).useAll
    @State private var preparedMeetingTitle: String?
    @ObservedObject private var joining = MeetingJoinCoordinator.shared
    @State private var localLink = ""
    @State private var manualConsent = false
    @State private var updatingCalendars = false
    @State private var lastCalendarUpdate: Date?
    @State private var calendarActionMessage: String?

    private static let selectionKey = "meetingCalendar.selectedIDs"

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Meeting calendars").font(.title2.weight(.semibold))
                Spacer()
                if updatingCalendars {
                    ProgressView().controlSize(.small)
                    Text("Updating calendars…").font(.caption).foregroundStyle(.secondary)
                } else if let lastCalendarUpdate {
                    Text("Last checked \(lastCalendarUpdate.formatted(date: .omitted, time: .shortened))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Button("Refresh") { Task { await updateCalendars() } }
                    .disabled(updatingCalendars)
            }
            if let calendarActionMessage {
                Text(calendarActionMessage).font(.callout).foregroundStyle(.secondary)
            }

            GroupBox("Reel notetaker") {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(joining.visibleCloudCalendarStatus).font(.callout)
                        Spacer()
                        if CloudConfig.default.isConfigured {
                            Button("Manage Google Calendar…", action: openCloudCalendar)
                        }
                    }
                    Text("Reel joins supported Google Meet and Teams calls from your connected Google Calendar, even when this Mac is closed.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }

            GroupBox("Join in Chrome on this Mac") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("For other eligible calls, keep Reel open and this Mac awake.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    if joining.hasStandingConsentForCurrentScope {
                        Toggle("Join eligible calls automatically", isOn: Binding(
                            get: { joining.autoJoin }, set: { joining.setAutomaticJoining($0) }))
                            .disabled(joining.busy)
                    } else {
                        Button("Set up joining in Chrome…") {
                            (NSApp.delegate as? AppDelegate)?.showMeetingSetup()
                        }.disabled(model.phase != .idle || joining.busy)
                    }
                    if joining.autoJoin || joining.busy {
                        Text(joining.visibleCalendarStatus)
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    Divider()
                    HStack {
                        TextField("Or paste a Google Meet, Zoom or Teams link", text: $localLink)
                        Button("Use link") { joining.prepareLink(localLink) }.disabled(joining.busy)
                    }
                    Picker("Meeting", selection: $joining.selectedID) {
                        Text("Choose a meeting").tag(String?.none)
                        ForEach(joining.visibleMeetings) { meeting in Text(meeting.title).tag(Optional(meeting.id)) }
                    }
                    if let meeting = joining.selected, !joining.hasStandingConsent(for: meeting) {
                        Toggle("Participants have agreed to recording", isOn: $manualConsent)
                            .disabled(joining.busy)
                    }
                    HStack {
                        Button("Join in Chrome and record") {
                            if let meeting = joining.selected {
                                joining.join(meeting, confirmed: manualConsent || joining.hasStandingConsent(for: meeting))
                            }
                        }.disabled(joining.busy || joining.selected.map { !(manualConsent || joining.hasStandingConsent(for: $0)) } != false)
                        Button("Prepare recording") {
                            if let meeting = joining.selected { prepare(meeting) }
                        }.disabled(joining.busy || joining.selected == nil || model.phase != .idle)
                        if joining.busy { Button("Cancel setup") { joining.cancel() } }
                        if let url = joining.accessibilitySettingsURL {
                            Button("Open Accessibility settings") { NSWorkspace.shared.open(url) }
                        }
                    }
                    if !joining.visibleStatus.isEmpty { Text(joining.visibleStatus).font(.caption).fixedSize(horizontal: false, vertical: true) }
                    Toggle("Prompt when a calendar meeting starts", isOn: $joining.reminders)
                }.padding(4)
            }

            GroupBox("Apple Calendar") {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(discovery.authorizationMessage).font(.callout).foregroundStyle(.secondary)
                        Spacer()
                        Button(desktopCalendarActionTitle, action: connectDesktopCalendars)
                            .disabled(updatingCalendars)
                    }
                    if hasDesktopCalendarAccess {
                        Text("\(discovery.calendars.count) calendars found on this Mac")
                            .font(.caption).foregroundStyle(.secondary)
                        Toggle("Use all calendars on this Mac", isOn: $useAllCalendars)
                            .onChange(of: useAllCalendars) { _, value in
                                joining.invalidateStandingConsent()
                                OrganizationState.defaults.set(value, forKey: "meetingCalendar.useAll")
                                Task { await refresh(); await joining.refresh() }
                            }
                        if !useAllCalendars && !discovery.calendars.isEmpty {
                            ScrollView {
                                VStack(alignment: .leading, spacing: 4) {
                                    ForEach(discovery.calendars) { calendar in
                                        Toggle(isOn: selectionBinding(for: calendar.id)) {
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(calendar.title)
                                                Text(calendar.accountName).font(.caption).foregroundStyle(.secondary)
                                            }
                                        }
                                        .toggleStyle(.checkbox)
                                    }
                                }
                            }
                            .frame(maxHeight: 145)
                        }
                    }
                }
            }

            HStack {
                Text("Upcoming calls in Apple Calendar").font(.headline)
                Spacer()
                Text("\(discovery.meetings.count) found · Next 7 days").font(.caption).foregroundStyle(.secondary)
            }

            if discovery.meetings.isEmpty {
                ContentUnavailableView(
                    "No upcoming calls from Apple Calendar",
                    systemImage: "calendar",
                    description: Text(hasDesktopCalendarAccess
                        ? "Reel looks for Google Meet, Zoom and Teams links in your selected calendars."
                        : "Allow Reel to read calendars synced to Apple Calendar.")
                )
            } else {
                List(discovery.meetings) { meeting in
                    meetingRow(meeting)
                }
                .listStyle(.inset)
            }

            if let preparedMeetingTitle {
                Text("Ready to record: \(preparedMeetingTitle). Close this window and start the meeting recording in Reel.")
                    .font(.callout.weight(.medium)).foregroundStyle(.green)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(18)
        .frame(width: 680, height: 760)
        .task { await refreshPeriodically() }
        .task(id: model.accountGeneration) {
            preparedMeetingTitle = nil
            manualConsent = false
            await joining.refresh()
        }
        .onChange(of: joining.selectedID) { _, _ in manualConsent = false }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await refresh() }
        }
    }

    private func meetingRow(_ meeting: CalendarMeeting) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(meeting.title).font(.body.weight(.medium)).lineLimit(1)
                Text(meeting.start.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption).foregroundStyle(.secondary)
                Text(platformName(meeting.platform)).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button("Open meeting") { NSWorkspace.shared.open(meeting.joinURL) }
            Button("Prepare recording") { prepare(meeting) }
                .buttonStyle(.borderedProminent)
        }
        .padding(.vertical, 3)
    }

    private func selectionBinding(for id: String) -> Binding<Bool> {
        Binding(get: { selectedCalendarIDs.contains(id) }, set: { selected in
            joining.invalidateStandingConsent()
            if selected { selectedCalendarIDs.insert(id) } else { selectedCalendarIDs.remove(id) }
            OrganizationState.defaults.set(Array(selectedCalendarIDs), forKey: Self.selectionKey)
            Task { await refresh(); await joining.refresh() }
        })
    }

    private var hasDesktopCalendarAccess: Bool {
        EKEventStore.authorizationStatus(for: .event) == .fullAccess
    }

    private var desktopCalendarActionTitle: String {
        if hasDesktopCalendarAccess { return "Open Apple Calendar…" }
        if discovery.accessNeedsSettings { return "Open calendar privacy settings…" }
        return "Allow calendar access"
    }

    private func connectDesktopCalendars() {
        calendarActionMessage = nil
        if hasDesktopCalendarAccess {
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.iCal"),
               NSWorkspace.shared.open(url) {
                calendarActionMessage = "In Apple Calendar, open Settings → Accounts to add or manage accounts."
            } else {
                calendarActionMessage = "Apple Calendar could not be opened. Manage your calendar accounts in System Settings → Internet Accounts."
            }
        } else if discovery.accessNeedsSettings {
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"),
               NSWorkspace.shared.open(url) {
                return
            }
            calendarActionMessage = "Open System Settings → Privacy & Security → Calendars and allow Reel."
        } else {
            Task { await updateCalendars(requestAccess: true) }
        }
    }

    private func openCloudCalendar() {
        calendarActionMessage = nil
        let page = CloudConfig.default.viewerBase.appendingPathComponent("record")
        guard var components = URLComponents(url: page, resolvingAgainstBaseURL: false) else { return }
        components.fragment = "meeting-calendar-panel"
        if let url = components.url, NSWorkspace.shared.open(url) { return }
        calendarActionMessage = "The Reel website could not be opened."
    }

    @MainActor
    private func updateCalendars(requestAccess: Bool = false) async {
        guard !updatingCalendars else { return }
        updatingCalendars = true
        defer { updatingCalendars = false }
        calendarActionMessage = nil
        if requestAccess { await discovery.connect() }
        await refresh()
        await joining.refresh()
        lastCalendarUpdate = Date()
    }

    @MainActor
    private func refresh() async {
        await discovery.refresh(selectedCalendarIDs: selectedCalendarIDs, useAllCalendars: useAllCalendars)
    }

    @MainActor
    private func refreshPeriodically() async {
        await refresh()
        while !Task.isCancelled {
            do { try await Task.sleep(nanoseconds: 60_000_000_000) }
            catch { return }
            guard !Task.isCancelled else { return }
            await refresh()
        }
    }

    private func prepare(_ meeting: CalendarMeeting) {
        model.meetingMode = true
        model.meetingTitle = meeting.title
        model.meetingAttendees = Array(Set(meeting.attendeeEmails + [meeting.organizer].compactMap { $0 }))
            .sorted().joined(separator: ", ")
        model.meetingCalendarOccurrenceID = meeting.id
        model.meetingCalendarReference = meeting.deliveryCalendar
        preparedMeetingTitle = meeting.title
    }

    private func platformName(_ platform: MeetingPlatform) -> String {
        switch platform {
        case .googleMeet: "Google Meet"
        case .zoom: "Zoom"
        case .teams: "Microsoft Teams"
        }
    }
}
