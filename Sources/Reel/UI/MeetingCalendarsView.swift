import AppKit
import EventKit
import ReelCore
import SwiftUI

/// Explicit setup and visible status for owner-bound local meeting automation.
struct MeetingCalendarsView: View {
    @ObservedObject var model: AppModel
    @StateObject private var discovery = CalendarDiscovery()
    @State private var preparedMeetingTitle: String?
    @ObservedObject private var joining = MeetingJoinCoordinator.shared
    @State private var localLink = ""
    @State private var manualConsent = false
    @State private var updatingCalendars = false
    @State private var lastCalendarUpdate: Date?
    @State private var calendarActionMessage: String?
    @State private var showCalendarSettings = false
    @State private var showManualLink = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            joiningStatus
            meetingList
            Divider()
            controls
        }
        .padding(20)
        .frame(width: 560, height: 420)
        .sheet(isPresented: $showCalendarSettings) { calendarSettings }
        .task { await refreshPeriodically() }
        .task(id: model.accountGeneration) {
            preparedMeetingTitle = nil
            manualConsent = false
            await joining.refresh()
        }
        .onChange(of: joining.selectedID) { _, _ in
            manualConsent = false
            preparedMeetingTitle = nil
        }
        .onChange(of: joining.desktopCalendarSelection) { _, _ in discovery.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            discovery.refresh()
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("Meetings").font(.title2.weight(.semibold))
            Spacer()
            if updatingCalendars {
                ProgressView().controlSize(.small).accessibilityLabel("Refreshing meetings")
            }
            Button {
                Task { await updateCalendars() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise").labelStyle(.iconOnly)
            }
            .help(lastCalendarUpdate.map { "Last checked " + $0.formatted(date: .omitted, time: .shortened) }
                ?? "Refresh meetings")
            .disabled(updatingCalendars)

            Button {
                calendarActionMessage = nil
                showCalendarSettings = true
            } label: {
                Label("Calendar settings", systemImage: "gearshape").labelStyle(.iconOnly)
            }
            .help("Calendar settings")
        }
    }

    private var joiningStatus: some View {
        HStack(spacing: 10) {
            Image(systemName: "laptopcomputer")
                .font(.title3).foregroundStyle(.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Automatic joining").font(.subheadline.weight(.semibold))
                Text(joining.hasStandingConsentForCurrentScope
                     ? joining.autoJoin ? "On for this Mac while it’s awake" : "Paused on this Mac"
                     : "Set up Reel to join meetings on this Mac.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if joining.hasStandingConsentForCurrentScope {
                Toggle("Automatic joining", isOn: Binding(
                    get: { joining.autoJoin }, set: { joining.setAutomaticJoining($0) }))
                    .toggleStyle(.switch).labelsHidden().controlSize(.small)
                    .disabled(joining.busy)
            } else {
                Button("Set Up…") { (NSApp.delegate as? AppDelegate)?.showMeetingSetup() }
                    .disabled(model.phase != .idle || joining.busy)
            }
        }
        .padding(11)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 9))
    }

    private var meetingList: some View {
        let meetings = joining.visibleMeetings.filter { $0.calendarID != "manual" }
        let cloudMeetings = joining.visibleCloudMeetings
        return VStack(alignment: .leading, spacing: 8) {
            Text("Upcoming").font(.headline).accessibilityAddTraits(.isHeader)
            if meetings.isEmpty && cloudMeetings.isEmpty {
                VStack(spacing: 7) {
                    Image(systemName: "calendar").font(.title2).foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    Text("No upcoming meetings").font(.subheadline.weight(.medium))
                    Text(googleCalendarIssue ?? "Check your calendars or use a meeting link.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(meetings.enumerated()), id: \.element.id) { index, meeting in
                            if index == 0 || !Calendar.current.isDate(meeting.start, inSameDayAs: meetings[index - 1].start) {
                                Text(dayLabel(meeting.start))
                                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                    .accessibilityAddTraits(.isHeader).padding(.top, index == 0 ? 2 : 8)
                            }
                            meetingRow(meeting)
                        }
                        ForEach(cloudMeetings) { meeting in
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(meeting.title).fontWeight(.medium).lineLimit(1)
                                    Text(meeting.start.formatted(date: .abbreviated, time: .shortened))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Label("Cloud", systemImage: "cloud").font(.caption).foregroundStyle(.secondary)
                            }
                            .padding(8)
                        }
                    }
                }
                .defaultScrollAnchor(.top)
            }
        }
        .frame(maxHeight: .infinity)
    }

    private func dayLabel(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) { return "Today" }
        if Calendar.current.isDateInTomorrow(date) { return "Tomorrow" }
        return date.formatted(.dateTime.weekday(.wide).day().month(.abbreviated))
    }

    private func meetingRow(_ meeting: CalendarMeeting) -> some View {
        let isSelected = joining.selectedID == meeting.id
        return Button {
            joining.selectedID = isSelected ? nil : meeting.id
        } label: {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(meeting.title).fontWeight(.medium).lineLimit(1)
                    Text(meeting.start.formatted(date: .omitted, time: .shortened) + " · " + platformName(meeting.platform))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark").font(.caption.weight(.semibold))
                        .foregroundStyle(Color.accentColor).accessibilityHidden(true)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            if showManualLink {
                HStack {
                    TextField("Paste a Meet, Zoom or Teams link", text: $localLink)
                        .onSubmit(useLink)
                    Button("Use Link", action: useLink)
                        .disabled(joining.busy || localLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            if let meeting = joining.selected, meeting.calendarID == "manual" {
                Label(platformName(meeting.platform) + " link ready", systemImage: "link")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let meeting = joining.selected, !joining.hasStandingConsent(for: meeting) {
                Toggle("Participants have agreed to recording", isOn: $manualConsent)
                    .toggleStyle(.checkbox)
                    .disabled(joining.busy)
            }
            HStack(spacing: 10) {
                Button(showManualLink ? "Hide Link" : "Use a Meeting Link…") { showManualLink.toggle() }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                Spacer()
                if joining.busy {
                    Button("Cancel Join") { joining.cancel() }
                } else if let meeting = joining.selected {
                    Menu("More") {
                        Button("Open Meeting") { NSWorkspace.shared.open(meeting.joinURL) }
                        Button("Prepare Manual Recording") { prepare(meeting) }
                            .disabled(model.phase != .idle)
                    }
                    .fixedSize()
                    Button("Join & Record") {
                        preparedMeetingTitle = nil
                        joining.join(meeting, confirmed: manualConsent || joining.hasStandingConsent(for: meeting))
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.phase != .idle || !(manualConsent || joining.hasStandingConsent(for: meeting)))
                }
            }
            if let url = joining.accessibilitySettingsURL {
                Button("Open Accessibility Settings") { NSWorkspace.shared.open(url) }
            }
            if let preparedMeetingTitle {
                Text("Ready to record “\(preparedMeetingTitle)” in Reel.")
                    .font(.caption).foregroundStyle(.secondary)
            } else if !joining.visibleStatus.isEmpty {
                Text(joining.visibleStatus).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if joining.autoJoin && !joining.visibleCalendarStatus.hasPrefix("Joining in Chrome is on") {
                Text(joining.visibleCalendarStatus).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var googleCalendarIssue: String? {
        guard CloudConfig.default.isConfigured else { return nil }
        if model.account == nil { return "Sign in to see Google Calendar meetings." }
        if joining.visibleCloudCalendarStatus.hasPrefix("Reel notetaker meetings are unavailable") {
            return "Google Calendar couldn’t be checked. Refresh to retry."
        }
        return nil
    }

    private var calendarSettings: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Calendars").font(.title3.weight(.semibold))
                Spacer()
                Button("Done") { showCalendarSettings = false }.keyboardShortcut(.defaultAction)
            }
            if CloudConfig.default.isConfigured {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Label("Google Calendar", systemImage: "calendar")
                        if let googleCalendarIssue {
                            Text(googleCalendarIssue).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button("Manage…", action: openCloudCalendar)
                }
            }
            Divider()
            HStack {
                Label("Apple Calendar", systemImage: "calendar")
                Spacer()
                Button(desktopCalendarActionTitle, action: connectDesktopCalendars)
                    .disabled(updatingCalendars)
            }
            if hasDesktopCalendarAccess {
                DesktopCalendarPicker(calendars: discovery.calendars)
            } else {
                Text(discovery.authorizationMessage).font(.caption).foregroundStyle(.secondary)
            }
            Toggle("Remind me when a meeting starts", isOn: $joining.reminders)
            if let calendarActionMessage {
                Text(calendarActionMessage).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(20)
        .frame(width: 445)
    }

    private func useLink() {
        guard !joining.busy, !localLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        joining.prepareLink(localLink)
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
        if let url = CloudConfig.default.notetakerURL, NSWorkspace.shared.open(url) { return }
        calendarActionMessage = "Reel Notetaker could not be opened."
    }

    @MainActor
    private func updateCalendars(requestAccess: Bool = false) async {
        guard !updatingCalendars else { return }
        updatingCalendars = true
        defer { updatingCalendars = false }
        calendarActionMessage = nil
        if requestAccess { await discovery.connect() }
        discovery.refresh()
        await joining.refresh()
        lastCalendarUpdate = Date()
    }

    @MainActor
    private func refreshPeriodically() async {
        discovery.refresh()
        while !Task.isCancelled {
            do { try await Task.sleep(nanoseconds: 60_000_000_000) }
            catch { return }
            guard !Task.isCancelled else { return }
            await updateCalendars()
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

struct DesktopCalendarPicker: View {
    let calendars: [CalendarSource]
    @ObservedObject private var joining = MeetingJoinCoordinator.shared
    @State private var draft: Set<String> = []

    var body: some View {
        let groups = Dictionary(grouping: calendars) { $0.accountID ?? $0.accountName }
        let accountIDs = groups.keys.sorted {
            (groups[$0]?.first?.accountName ?? "", $0) < (groups[$1]?.first?.accountName ?? "", $1)
        }
        let availableDraft = draft.intersection(calendars.map(\.id))
        VStack(alignment: .leading, spacing: 8) {
            if !calendars.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(accountIDs, id: \.self) { accountID in
                            if let group = groups[accountID], let account = group.first {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(account.accountName).font(.subheadline.weight(.semibold))
                                        .accessibilityAddTraits(.isHeader)
                                    ForEach(group.sorted { ($0.title, $0.id) < ($1.title, $1.id) }) { calendar in
                                        Toggle(calendar.title, isOn: selectionBinding(for: calendar.id))
                                            .toggleStyle(.checkbox)
                                    }
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 145)
            }
            HStack {
                Button("Save selection") { joining.saveDesktopCalendarSelection(availableDraft) }
                    .disabled(joining.desktopCalendarSelection == .saved(availableDraft))
                Text("Save with no calendars checked to skip Apple Calendar.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .onChange(of: joining.desktopCalendarSelection, initial: true) { _, selection in
            draft = selection.savedIDs ?? []
        }
    }

    private func selectionBinding(for id: String) -> Binding<Bool> {
        Binding(get: { draft.contains(id) }, set: { selected in
            if selected { draft.insert(id) } else { draft.remove(id) }
        })
    }
}
