import AppKit
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

    private static let selectionKey = "meetingCalendar.selectedIDs"

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Meeting calendars").font(.title2.weight(.semibold))
                    Text(discovery.authorizationMessage).font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Guided setup…") {
                    (NSApp.delegate as? AppDelegate)?.showMeetingSetup()
                }
                Button("Connect calendars") {
                    Task {
                        await discovery.connect()
                        await refresh()
                    }
                }
                if discovery.accessNeedsSettings {
                    Button("Open calendar settings") {
                        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars")!)
                    }
                }
                Button("Refresh") { Task { await refresh() } }
            }

            GroupBox("Join and record on this Mac") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Uses your signed-in Chrome profile and records the meeting window locally. Keep Reel open and this Mac awake.")
                    Text("Sign in to Reel for meeting transcription and AI notes. Meeting audio is sent securely to OpenAI; video stays on this Mac. Transcript seek times are approximate.")
                        .font(.caption).foregroundStyle(.secondary)
                        .font(.caption).foregroundStyle(.secondary)
                    HStack {
                        TextField("Or paste a Google Meet, Zoom or Teams link", text: $localLink)
                        Button("Use link") { joining.prepareLink(localLink) }.disabled(joining.busy)
                    }
                    Picker("Meeting", selection: $joining.selectedID) {
                        Text("Choose a meeting").tag(String?.none)
                        ForEach(joining.meetings) { meeting in Text(meeting.title).tag(Optional(meeting.id)) }
                    }
                    HStack {
                        Button("Join in Chrome and record") {
                            if let meeting = joining.selected { joining.join(meeting, confirmed: true) }
                        }.disabled(joining.busy || joining.selected == nil)
                        Button("Prepare recording") {
                            if let meeting = joining.selected { prepare(meeting) }
                        }.disabled(joining.busy || joining.selected == nil || model.phase != .idle)
                        if joining.busy { Button("Cancel setup") { joining.cancel() } }
                        if let url = joining.accessibilitySettingsURL {
                            Button("Open Accessibility settings") { NSWorkspace.shared.open(url) }
                        }
                    }
                    if !joining.status.isEmpty { Text(joining.status).font(.caption).fixedSize(horizontal: false, vertical: true) }
                    Text(joining.calendarStatus).font(.callout).fixedSize(horizontal: false, vertical: true)
                    Toggle("Prompt when a calendar meeting starts", isOn: $joining.reminders)
                    Toggle("Participants in my selected desktop and Reel-connected Google calendars have agreed to recording", isOn: $joining.standingConsent)
                    Toggle("Automatically join and record calendar meetings on this Mac", isOn: $joining.autoJoin)
                        .disabled(!joining.standingConsent || joining.busy)
                    Text("Enable automatic joining once for this Reel account after connecting calendars once. All desktop calendars are included by default. Meetings already in progress by more than five minutes are skipped. Reel cannot join while this Mac is asleep or the app is closed.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Text("Automatic capture records computer sound with the microphone off. Manual joining includes your microphone. Some calls require host admission or manual sign-in.")
                        .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }.padding(4)
            }

            GroupBox("Desktop calendars") {
                VStack(alignment: .leading, spacing: 8) {
                Toggle("Use all calendars on this Mac", isOn: $useAllCalendars)
                    .onChange(of: useAllCalendars) { _, value in
                        joining.standingConsent = false
                        OrganizationState.defaults.set(value, forKey: "meetingCalendar.useAll")
                        Task { await refresh(); await joining.refresh() }
                    }
                if useAllCalendars {
                    Text("Includes Google, Apple and other accounts synced to Apple Calendar. New calendars are included automatically.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if discovery.calendars.isEmpty {
                    Text("Connect calendars once. No individual calendar selection is needed.")
                        .font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 5)
                } else if !useAllCalendars {
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

            HStack {
                Text("Upcoming meetings").font(.headline)
                Spacer()
                Text("Next 7 days").font(.caption).foregroundStyle(.secondary)
            }

            if discovery.meetings.isEmpty {
                ContentUnavailableView("No meetings found", systemImage: "calendar", description: Text("Connect your desktop calendars to find upcoming meetings with a supported call link."))
            } else {
                List(discovery.meetings) { meeting in
                    meetingRow(meeting)
                }
                .listStyle(.inset)
            }

            Text("Google Calendar meetings connected in Reel also appear in the join selector when you are signed in. Other calendar accounts can be selected above after connecting them in macOS.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let preparedMeetingTitle {
                Text("Ready to record: \(preparedMeetingTitle). Close this window and start the meeting recording in Reel.")
                    .font(.callout.weight(.medium)).foregroundStyle(.green)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(18)
        .frame(width: 680, height: 760)
        .task { await joining.refresh(); await refreshPeriodically() }
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
            joining.standingConsent = false; joining.autoJoin = false
            OrganizationState.defaults.set(false, forKey: "meetingCalendar.standingConsent")
            if selected { selectedCalendarIDs.insert(id) } else { selectedCalendarIDs.remove(id) }
            OrganizationState.defaults.set(Array(selectedCalendarIDs), forKey: Self.selectionKey)
            Task { await refresh() }
        })
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
