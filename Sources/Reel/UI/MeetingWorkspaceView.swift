import AppKit
import ReelCore
import SwiftUI

struct MeetingWorkspaceView: View {
    @ObservedObject var model: AppModel
    let showRecorder: () -> Void
    @ObservedObject private var joining = MeetingJoinCoordinator.shared
    @StateObject private var notes = ParticipantNotesLibrary()
    @State private var sharedOnly = false
    @State private var search = ""
    @State private var selection: Selection?
    @State private var showAllUpcoming = false
    @State private var manualConsent = false
    @State private var transcriptSelected = false
    @State private var refreshing = false
    @State private var lastRefresh: Date?

    private enum Selection: Hashable { case upcoming(String), cloud(String), local(String), shared(String) }
    private struct UpcomingCall: Identifiable {
        let id: Selection
        let title: String
        let start: Date
        let symbol: String
        let status: String
    }
    private struct PastCall: Identifiable {
        let id: Selection
        let title: String
        let date: Date
        let duration: Double
        let status: String
        let shared: Bool
    }
    private var upcoming: [UpcomingCall] {
        let local = joining.visibleMeetings.filter { $0.calendarID != "manual" }.map {
            UpcomingCall(id: .upcoming($0.id), title: $0.title, start: $0.start,
                         symbol: "video", status: $0.start <= Date() ? "Now · On this Mac" : platformName($0.platform))
        }
        let cloud = joining.visibleCloudMeetings.map {
            UpcomingCall(id: .cloud($0.id), title: $0.title, start: $0.start,
                         symbol: "cloud", status: cloudStatus($0))
        }
        return (local + cloud).filter { matches($0.title) }.sorted { $0.start < $1.start }
    }
    private var history: [PastCall] {
        let remote = notes.meetings.filter { !sharedOnly || $0.localRecordingIDs.isEmpty }.map {
            PastCall(id: .shared($0.id), title: $0.title, date: $0.startedAt,
                     duration: $0.durationSeconds, status: "Notes ready", shared: $0.localRecordingIDs.isEmpty)
        }
        let local = sharedOnly ? [] : MeetingWorkspaceHistory.localRecordings(
            model.recordings, ownerUserID: model.account?.userID, shared: notes.meetings).map {
                PastCall(id: .local($0.id), title: $0.title, date: $0.createdAt,
                         duration: $0.durationSeconds, status: Self.status($0), shared: false)
            }
        return (remote + local).filter { matches($0.title) }.sorted { $0.date > $1.date }
    }
    private var days: [Date] {
        Array(Set(history.map { Calendar.current.startOfDay(for: $0.date) })).sorted(by: >)
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar.frame(width: 184)
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                header.padding(24)
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        recordingStatus
                        if joining.busy { calendarStatus }
                        if model.account == nil { signInPrompt }
                        else {
                            if !joining.busy && !sharedOnly && search.isEmpty { calendarStatus }
                            if !sharedOnly && !upcoming.isEmpty { upcomingSection }
                            if !sharedOnly && search.isEmpty && joining.visibleCloudMeetings.isEmpty {
                                Label(joining.visibleCloudCalendarStatus, systemImage: "cloud")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            historySection
                        }
                    }.padding(24)
                }
            }.frame(minWidth: 420, maxWidth: .infinity)
            Divider()
            detail.frame(width: 370)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .tint(Color(red: 0.08, green: 0.38, blue: 0.36))
        .task(id: model.accountGeneration) {
            selection = nil
            lastRefresh = nil
            notes.reset()
            await refresh()
        }
        .onChange(of: selection) { _, _ in
            manualConsent = false
            transcriptSelected = false
        }
        .task(id: selection) {
            if case .shared(let id) = selection { await notes.loadDetail(id: id) }
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 9) {
                Image(systemName: "waveform.circle.fill").font(.system(size: 30)).foregroundStyle(.tint)
                Text("Reel").font(.system(size: 25, weight: .semibold, design: .rounded))
            }.padding(.vertical, 22).padding(.horizontal, 10)
            sidebarButton("Meetings", symbol: "rectangle.stack", selected: !sharedOnly) {
                sharedOnly = false; selection = nil
            }
            sidebarButton("Shared with me", symbol: "person.2", selected: sharedOnly) {
                sharedOnly = true; selection = nil
            }
            Divider().padding(.vertical, 12)
            sidebarButton("Calendar settings", symbol: "calendar", selected: false) {
                (NSApp.delegate as? AppDelegate)?.showMeetings()
            }
            sidebarButton("Local recordings", symbol: "film", selected: false) {
                (NSApp.delegate as? AppDelegate)?.showLibrary()
            }
            Spacer()
            if let account = model.account {
                Label {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(account.displayName ?? "Your account").font(.callout.weight(.medium))
                        Text(account.email).font(.caption2).foregroundStyle(.secondary)
                    }.lineLimit(1)
                } icon: { Image(systemName: "person.crop.circle").font(.title2) }
                .padding(10)
            }
            sidebarButton("Settings", symbol: "gearshape", selected: false) {
                (NSApp.delegate as? AppDelegate)?.showSettings()
            }
        }
        .padding(12)
        .background(Color.primary.opacity(0.025))
    }

    private func sidebarButton(_ title: String, symbol: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol).font(.callout.weight(selected ? .semibold : .regular))
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 10).padding(.vertical, 11)
                .background(selected ? Color.accentColor.opacity(0.10) : .clear, in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text(sharedOnly ? "Shared with me" : "Meetings").font(.system(size: 27, weight: .semibold))
                Spacer()
                if refreshing { ProgressView().controlSize(.small).accessibilityLabel("Refreshing meetings") }
                else if let lastRefresh {
                    Text("Checked \(lastRefresh.formatted(date: .omitted, time: .shortened))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .help("Refresh meetings and notes").accessibilityLabel("Refresh meetings and notes")
                    .disabled(refreshing || notes.loading)
                Button("Record an open call", systemImage: "record.circle") { prepareRecording(nil) }
                    .disabled(model.isBusy || joining.busy || model.account == nil)
            }
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search meetings", text: $search).textFieldStyle(.plain)
                if !search.isEmpty { Button { search = "" } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain) }
            }.padding(10).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 9))
        }
    }

    @ViewBuilder private var recordingStatus: some View {
        if model.phase != .idle {
            HStack(spacing: 12) {
                Image(systemName: model.phase == .paused ? "pause.circle.fill" : "record.circle.fill")
                    .foregroundStyle(model.phase == .paused ? .orange : .red).font(.title2)
                VStack(alignment: .leading, spacing: 4) {
                    Text(phaseLabel).font(.headline)
                    if model.phase == .recording || model.phase == .paused {
                        TimelineView(.periodic(from: .now, by: 1)) { _ in
                            Text(Self.duration(RecorderController.shared.elapsed)).monospacedDigit().foregroundStyle(.secondary)
                        }
                    }
                }
                Spacer()
                if model.phase == .recording || model.phase == .paused {
                    Button("Stop recording") { RecorderController.shared.stop() }
                }
            }.padding(16).background(Color.red.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
        }
    }
    private var phaseLabel: String {
        switch model.phase {
        case .idle: "Ready to record"
        case .preparing: "Preparing recording"
        case .countdown: "Recording starts after the countdown"
        case .recording: "Recording on this Mac"
        case .paused: "Recording paused"
        case .finishing: "Saving recording"
        }
    }

    private var calendarStatus: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Label(joining.autoJoin && joining.standingConsent ? "Joining on this Mac is on" : "Joining on this Mac is off",
                      systemImage: "calendar.badge.clock").font(.callout.weight(.medium))
                Spacer()
                Button("Manage") { (NSApp.delegate as? AppDelegate)?.showMeetings() }.controlSize(.small)
            }
            if joining.autoJoin || joining.busy {
                Text(joining.visibleCalendarStatus).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Cloud meetings appear below. Manage local recording in Calendar settings.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if !joining.visibleStatus.isEmpty {
                Text(joining.busy ? joining.visibleStatus : "Last join update: \(joining.visibleStatus)")
                    .font(.caption).fixedSize(horizontal: false, vertical: true)
            }
            if joining.busy { Button("Cancel joining") { joining.cancel() }.controlSize(.small) }
        }.padding(16).background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
    }

    private var upcomingSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("UPCOMING").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(showAllUpcoming ? upcoming : Array(upcoming.prefix(4))) { meeting in
                Button { selection = meeting.id } label: {
                    HStack(spacing: 12) {
                        Image(systemName: meeting.symbol).font(.title3).foregroundStyle(.tint).frame(width: 34)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(meeting.title).font(.callout.weight(.medium)).lineLimit(2)
                            Text("\(Self.dayLabel(meeting.start)) · \(meeting.start.formatted(date: .omitted, time: .shortened))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(meeting.status)
                            .font(.caption).foregroundStyle(.secondary)
                        Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                    }.padding(14)
                        .background(selection == meeting.id ? Color.accentColor.opacity(0.1) : Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 10))
                        .contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            if upcoming.count > 4 {
                Button(showAllUpcoming ? "Show fewer meetings" : "Show all \(upcoming.count) meetings") { showAllUpcoming.toggle() }
                    .buttonStyle(.link).font(.caption)
            }
        }
    }

    private var historySection: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Past calls").font(.title3.weight(.semibold))
                Spacer()
                if notes.loading { ProgressView().controlSize(.small) }
            }
            if let error = notes.error {
                HStack {
                    Text(error).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Retry") { Task { await notes.refresh() } }.controlSize(.small).disabled(notes.loading)
                }
            }
            if history.isEmpty && !notes.loading {
                VStack(alignment: .leading, spacing: 6) {
                    Text(search.isEmpty ? "Your meeting notes will appear here" : "No matching meetings").font(.callout.weight(.medium))
                    Text(search.isEmpty ? "Recorded calls and notes shared with your organization account stay together here." : "Try another meeting title.")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding(.vertical, 24)
            }
            ForEach(days, id: \.self) { day in
                VStack(alignment: .leading, spacing: 5) {
                    Text(Self.dayLabel(day).uppercased()).font(.caption.weight(.medium)).foregroundStyle(.secondary).padding(.bottom, 4)
                    ForEach(history.filter { Calendar.current.isDate($0.date, inSameDayAs: day) }) { call in
                        Button { selection = call.id } label: {
                            HStack(spacing: 12) {
                                Image(systemName: call.shared ? "person.2" : "text.bubble")
                                    .foregroundStyle(.secondary).frame(width: 30)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(call.title).font(.callout.weight(.medium)).lineLimit(2)
                                    Text("\(call.date.formatted(date: .omitted, time: .shortened)) · \(Self.duration(call.duration)) · \(call.status)")
                                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                }
                                Spacer(minLength: 0)
                            }.padding(12)
                                .background(selection == call.id ? Color.accentColor.opacity(0.10) : .clear, in: RoundedRectangle(cornerRadius: 10))
                                .contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                }
            }
            if notes.nextCursor != nil {
                Button("Load older calls") { Task { await notes.loadMore() } }.disabled(notes.loading)
            }
        }
    }

    @ViewBuilder private var detail: some View {
        switch selection {
        case .upcoming(let id):
            if let meeting = joining.visibleMeetings.first(where: { $0.id == id }) { upcomingDetail(meeting) }
            else { emptyDetail }
        case .cloud(let id):
            if let meeting = joining.visibleCloudMeetings.first(where: { $0.id == id }) { cloudDetail(meeting) }
            else { emptyDetail }
        case .local(let id):
            if let recording = model.recording(id: id), let owner = model.account?.userID,
               recording.meeting?.ownerUserID == owner {
                LocalMeetingDetail(model: model, recording: recording).id("\(owner):\(id)")
            } else { emptyDetail }
        case .shared(let id):
            if let meeting = notes.meetings.first(where: { $0.id == id }) { sharedDetail(meeting) }
            else { emptyDetail }
        case nil: emptyDetail
        }
    }

    private var emptyDetail: some View {
        VStack(spacing: 14) {
            Image(systemName: "text.bubble").font(.system(size: 35, weight: .light)).foregroundStyle(.tertiary)
            Text("Your conversations, together").font(.headline)
            Text("Select a meeting to see its details, summary and transcript.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.padding(36).frame(maxHeight: .infinity)
    }

    private func upcomingDetail(_ meeting: CalendarMeeting) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                detailHeading(meeting.title, date: meeting.start, subtitle: platformName(meeting.platform))
                people(meeting.attendeeEmails, title: "CALENDAR INVITEES")
                Divider()
                Text("Join and record").font(.headline)
                Text("Opens the call in Chrome and records it on this Mac. The host may need to admit you.")
                    .font(.callout).foregroundStyle(.secondary)
                Text("Audio is sent to OpenAI for transcription and notes. Notes follow your Notion filing and participant sharing rules; video stays on this Mac.")
                    .font(.caption).foregroundStyle(.secondary)
                Toggle("Include my microphone", isOn: $model.meetingMicrophoneEnabled)
                if !joining.standingConsent {
                    Toggle("Participants have agreed to recording", isOn: $manualConsent)
                }
                Button("Join + record", systemImage: "video.badge.waveform") {
                    joining.join(meeting, confirmed: true, includeMicrophone: model.meetingMicrophoneEnabled)
                }.buttonStyle(.borderedProminent)
                    .disabled(model.isBusy || joining.busy || !(joining.standingConsent || manualConsent))
                Button("Already in this call? Prepare recording") { prepareRecording(meeting) }
                    .disabled(model.isBusy || joining.busy)
                Text("Calendar invitees in your organization receive notes after processing, including invitees who did not attend.")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(24)
        }
    }

    private func cloudDetail(_ meeting: CloudCalendarMeeting) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                detailHeading(meeting.title, date: meeting.start, subtitle: platformName(meeting.platform))
                Label(cloudStatus(meeting), systemImage: "cloud").font(.headline)
                people(meeting.attendeeEmails, title: "CALENDAR INVITEES")
                Text("After the call, the summary and transcript appear in Past calls once processing finishes.")
                    .font(.callout).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
        }
    }

    private func cloudStatus(_ meeting: CloudCalendarMeeting) -> String {
        switch meeting.status {
        case "recording": "Recording in the cloud"
        case "joined": "Cloud bot joined"
        case "awaiting_admission": "Waiting for the host"
        case "awaiting_consent": "Recording approval needed"
        case "dispatching", "requesting_entry": "Cloud bot joining"
        case "completed": "Cloud recording ended"
        case "failed": "Cloud recording failed"
        default: meeting.start <= Date() ? "Cloud join pending" : "Cloud scheduled"
        }
    }

    private func sharedDetail(_ meeting: SharedMeetingNote) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                detailHeading(meeting.title, date: meeting.startedAt, subtitle: Self.duration(meeting.durationSeconds))
                people(meeting.recipients, title: "NOTES SHARED WITH")
                Divider()
                Picker("Notes", selection: $transcriptSelected) {
                    Text("Summary").tag(false)
                    Text("Transcript").tag(true)
                }.pickerStyle(.segmented)
                if transcriptSelected {
                    if let transcript = notes.detail(id: meeting.id)?.transcriptText {
                        Text(transcript.isEmpty ? "No transcript available." : transcript).textSelection(.enabled)
                    } else if notes.detailLoadingID == meeting.id { ProgressView("Loading transcript…") }
                    else {
                        Text(notes.detailError ?? "Transcript is unavailable.").foregroundStyle(.secondary)
                        Button("Retry") { Task { await notes.loadDetail(id: meeting.id) } }
                    }
                } else { Text(meeting.summary).textSelection(.enabled) }
                Divider()
                if CloudConfig.default.isConfigured, let url = URL(string: "#meetings/\(meeting.id)", relativeTo: CloudConfig.default.notesBaseURL) {
                    Link("Open in library", destination: url).font(.callout)
                }
                Text("Visible to the recipients listed above. These notes are not shared with the whole team.")
                    .font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
        }
    }

    private var signInPrompt: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Your meetings, privately organized").font(.title3.weight(.semibold))
            Text("Sign in with your organization account to see your calendar and the notes shared with you.").foregroundStyle(.secondary)
            Button("Sign in with Google") { Task { await model.signIn() } }.buttonStyle(.borderedProminent)
        }.padding(.vertical, 28)
    }

    private func prepareRecording(_ meeting: CalendarMeeting?) {
        guard !model.isBusy, !joining.busy else { return }
        model.meetingMode = true
        model.meetingTitle = meeting?.title ?? ""
        model.meetingAttendees = meeting.map { Array(Set($0.attendeeEmails + [$0.organizer].compactMap { $0 })).sorted().joined(separator: ", ") } ?? ""
        model.meetingCalendarOccurrenceID = meeting?.id
        model.meetingCalendarReference = meeting?.deliveryCalendar
        showRecorder()
    }
    private func refresh() async {
        let accountGeneration = model.accountGeneration
        refreshing = true
        defer { if accountGeneration == model.accountGeneration { refreshing = false } }
        model.reloadLibrary()
        async let calendar: Void = joining.refresh()
        await notes.refresh()
        await calendar
        if accountGeneration == model.accountGeneration, !Task.isCancelled, notes.error == nil {
            lastRefresh = Date()
        }
    }
    private func matches(_ title: String) -> Bool { search.isEmpty || title.localizedCaseInsensitiveContains(search) }
    private func platformName(_ platform: MeetingPlatform) -> String {
        switch platform { case .googleMeet: "Google Meet"; case .zoom: "Zoom"; case .teams: "Microsoft Teams" }
    }
    static func duration(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0, seconds < Double(Int.max) else { return "—" }
        let total = Int(seconds)
        return total >= 3600 ? String(format: "%d:%02d:%02d", total / 3600, total / 60 % 60, total % 60) : String(format: "%d:%02d", total / 60, total % 60)
    }
    static func dayLabel(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) { return "Today" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        if Calendar.current.isDateInTomorrow(date) { return "Tomorrow" }
        return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().year())
    }
    static func status(_ recording: Recording) -> String {
        if recording.captureState == .recording { return "Recording" }
        if recording.captureState == .finalizing { return "Saving" }
        if recording.meeting?.needsContentReview == true { return "Review transcript" }
        if recording.meeting?.deliveryStatus == .noSpeech { return "No speech detected" }
        if recording.transcriptStatus == .failed || recording.meeting?.deliveryStatus == .failed { return "Needs attention" }
        if recording.meeting?.deliveryStatus == .confirmed { return "Notes delivered" }
        if recording.transcriptStatus == .ready { return "Notes ready" }
        return "Processing notes"
    }
}

private func detailHeading(_ title: String, date: Date, subtitle: String) -> some View {
    VStack(alignment: .leading, spacing: 10) {
        Text(title).font(.title2.weight(.semibold)).textSelection(.enabled)
        Text(date.formatted(date: .abbreviated, time: .shortened)).font(.callout).foregroundStyle(.secondary)
        Text(subtitle).font(.caption).foregroundStyle(.secondary)
    }
}

private func people(_ emails: [String], title: String) -> some View {
    MeetingPeople(emails: Array(Set(emails)).sorted(), title: title)
}

private struct MeetingPeople: View {
    let emails: [String]
    let title: String
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if emails.isEmpty { Text("No invitee details available").font(.caption).foregroundStyle(.secondary) }
            ForEach(expanded ? emails : Array(emails.prefix(5)), id: \.self) { email in
                Label(email, systemImage: "person.crop.circle").font(.caption).textSelection(.enabled)
            }
            if emails.count > 5 {
                Button(expanded ? "Show fewer" : "Show \(emails.count - 5) more") { expanded.toggle() }
                    .buttonStyle(.link).font(.caption)
            }
        }
    }
}

private struct LocalMeetingDetail: View {
    @ObservedObject var model: AppModel
    let recording: Recording
    @State private var transcriptSelected = false
    @State private var transcript = ""
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                detailHeading(recording.title, date: recording.createdAt, subtitle: MeetingWorkspaceView.duration(recording.durationSeconds))
                Label(MeetingWorkspaceView.status(recording), systemImage: recording.meeting?.deliveryStatus == .confirmed ? "checkmark.circle" : "clock")
                    .font(.callout).foregroundStyle(.secondary)
                if let receipt = recording.meeting?.deliveryReceipt { people(receipt.recipients, title: "DELIVERED TO") }
                Divider()
                Picker("Notes", selection: $transcriptSelected) {
                    Text("Summary").tag(false)
                    Text("Transcript").tag(true)
                }.pickerStyle(.segmented)
                if recording.meeting?.deliveryStatus == .noSpeech {
                    Text("No speech was detected. The recording is saved, but no notes were sent.").foregroundStyle(.secondary)
                } else if transcriptSelected {
                    Text(transcript.isEmpty ? "Transcript is not ready yet." : transcript).textSelection(.enabled)
                } else if recording.meeting?.needsContentReview == true {
                    Text("Automatic notes delivery is paused. Review the saved transcript and recording; reprocess the recording if speech was missed.")
                        .foregroundStyle(.secondary)
                } else {
                    Text(recording.summary ?? "Notes will appear here after transcription finishes.").textSelection(.enabled)
                }
                if let error = recording.meeting?.deliveryError { Text(error).font(.caption).foregroundStyle(.secondary) }
                Divider()
                Button("Show recording files") { NSWorkspace.shared.open(model.library.folder(for: recording)) }
                if recording.meeting?.needsContentReview == true {
                    Button("Reprocess recording") { Publisher.shared.transcribeByUser(recording) }
                        .disabled(recording.transcriptStatus == .pending || model.account == nil)
                } else if recording.meeting?.deliveryStatus != nil && recording.meeting?.deliveryStatus != .confirmed && recording.meeting?.deliveryStatus != .noSpeech {
                    Button("Retry notes delivery") { Publisher.shared.deliverMeetingByUser(recording) }
                        .disabled(recording.transcriptStatus != .ready || model.account == nil)
                }
                if recording.meeting?.calendarOccurrenceID == nil {
                    Text("Manual recording: notes are delivered only to the account that recorded it.").font(.caption).foregroundStyle(.secondary)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
        }
        .task(id: recording.transcriptStatus) {
            let url = model.library.transcriptTextURL(for: recording)
            transcript = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        }
    }
}
