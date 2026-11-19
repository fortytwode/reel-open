import AppKit
import ReelCore
import SwiftUI

struct LibraryView: View {
    @ObservedObject var model: AppModel
    @State private var renaming: Recording?
    @State private var newTitle = ""
    @State private var deleting: Recording?
    @State private var sharing: Recording?
    @State private var trimming: Recording?
    @State private var search = ""
    @State private var meetingVideos = false
    @State private var meetingNotes: Recording?

    private var filtered: [Recording] {
        model.recordings.filter { recording in
            (recording.meeting != nil) == meetingVideos &&
                (search.isEmpty || recording.title.localizedCaseInsensitiveContains(search))
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button {
                    (NSApp.delegate as? AppDelegate)?.showScreenRecordingPanel()
                } label: { Label("New screen recording", systemImage: "record.circle") }
                    .disabled(model.isBusy)
                Spacer()
                TextField("Search", text: $search).textFieldStyle(.roundedBorder).frame(width: 200)
                Button { model.reloadLibrary() } label: { Image(systemName: "arrow.clockwise") }.help("Reload")
                Button { NSWorkspace.shared.open(model.library.root) } label: { Image(systemName: "folder") }.help("Show recordings folder")
            }
            .padding(12)
            VStack(alignment: .leading, spacing: 8) {
                Picker("Video type", selection: $meetingVideos) {
                    Text("Screen recordings").tag(false)
                    Text("Meeting videos").tag(true)
                }.pickerStyle(.segmented).fixedSize()
                Text(meetingVideos
                     ? "Meeting videos saved on this Mac. Open Meetings for summaries and transcripts."
                     : "Record your screen or camera and share a video link.")
                    .font(.callout).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading).padding([.horizontal, .bottom], 12)
            Divider()
            if filtered.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "video.badge.plus").font(.system(size: 36)).foregroundStyle(.secondary)
                    Text(search.isEmpty ? (meetingVideos ? "No meeting videos saved on this Mac" : "No screen recordings yet") : "No matches")
                        .font(.headline)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(filtered) { r in
                    LibraryRow(model: model, recording: r,
                               rename: { renaming = r; newTitle = r.title },
                               delete: { deleting = r },
                               share: { sharing = r },
                               trim: { trimming = r },
                               notes: { meetingNotes = r })
                }
                .listStyle(.inset)
            }
        }
        .frame(minWidth: 640, minHeight: 420)
        .sheet(item: $renaming) { r in
            VStack(alignment: .leading, spacing: 12) {
                Text("Rename recording").font(.headline)
                TextField("Title", text: $newTitle).frame(width: 360).onSubmit { commitRename(r) }
                HStack {
                    Spacer()
                    Button("Cancel") { renaming = nil }.keyboardShortcut(.cancelAction)
                    Button("Rename") { commitRename(r) }.keyboardShortcut(.defaultAction)
                }
            }
            .padding(20)
        }
        .sheet(item: $meetingNotes) { r in
            MeetingNotesView(model: model, recording: r)
        }
        .sheet(item: $sharing) { r in
            ShareSettingsView(model: model, recordingID: r.id) { sharing = nil }
        }
        .sheet(item: $trimming) { r in
            VStack(alignment: .leading, spacing: 8) {
                Text("Trim “\(r.title)”").font(.headline)
                Text("Drag the yellow handles, then click Trim. Viewers only see the trimmed part; the original is kept.")
                    .font(.caption).foregroundStyle(.secondary)
                TrimView(url: model.library.videoURL(for: r), initial: r.trim) { range, cancelled in
                    trimming = nil
                    guard !cancelled else { return }
                    Publisher.shared.setTrim(r, start: range?.start ?? 0, end: range?.end ?? r.durationSeconds)
                }
                .frame(width: 720, height: 440)
                HStack {
                    if r.trim != nil {
                        Button("Remove trim") { Publisher.shared.setTrim(r, start: 0, end: r.durationSeconds); trimming = nil }
                    }
                    Spacer()
                    Button("Close") { trimming = nil }.keyboardShortcut(.cancelAction)
                }
            }
            .padding(16)
        }
        .confirmationDialog("Delete “\(deleting?.title ?? "")”?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Delete from this Mac and the web", role: .destructive) {
                if let r = deleting { Task { await Publisher.shared.delete(r) } }
                deleting = nil
            }
        } message: {
            Text("The share link will stop working. Local files go to the Trash.")
        }
    }

    private func commitRename(_ r: Recording) {
        Publisher.shared.rename(r, to: newTitle)
        renaming = nil
    }
}

private struct LibraryRow: View {
    @ObservedObject var model: AppModel
    let recording: Recording
    let rename: () -> Void
    let delete: () -> Void
    let share: () -> Void
    let trim: () -> Void
    let notes: () -> Void
    @State private var confirmMeetingShare = false
    @State private var meetingShareConsent: Publisher.MeetingShareConsent?
    private var localVideoReady: Bool {
        recording.discardRequested != true && (recording.captureState == .complete || recording.captureState == .recovered)
    }

    var body: some View {
        HStack(spacing: 12) {
            thumbnail
            VStack(alignment: .leading, spacing: 3) {
                Text(recording.title).font(.headline).lineLimit(1)
                Text("\(recording.createdAt.formatted(date: .abbreviated, time: .shortened)) · \(Transcript.timestamp(recording.durationSeconds)) · \(recording.mode.label)")
                    .font(.caption).foregroundStyle(.secondary)
                status
            }
            Spacer()
            HStack(spacing: 6) {
                if recording.isMeeting { Button("Meeting notes", action: notes) }
                if recording.upload == .uploaded {
                    Button("Copy link") { Publisher.shared.copyLink(recording) }
                    Button { NSWorkspace.shared.open(recording.shareURL()) } label: { Image(systemName: "safari") }.help("Open share page")
                } else if localVideoReady && model.uploadProgress[recording.id] == nil {
                    Button(recording.isMeeting ? "Share video…" : "Upload") {
                        if recording.isMeeting {
                            guard let consent = Publisher.shared.meetingShareConsent() else {
                                Toast.show("Sign in to Reel before sharing a meeting.", isError: true)
                                return
                            }
                            meetingShareConsent = consent
                            confirmMeetingShare = true
                        } else { Publisher.shared.publish(recording, copyLink: true) }
                    }
                        .help(model.account == nil ? "Sign in with Google in Settings first" : "Upload and copy link")
                }
                Button { NSWorkspace.shared.open(model.library.videoURL(for: recording)) } label: { Image(systemName: "play.rectangle") }.help("Open video")
                    .disabled(!localVideoReady)
                Menu {
                    Button("Rename…", action: rename)
                    Button("Share settings (password, expiry)…", action: share)
                    Button("Trim…", action: trim).disabled(!localVideoReady)
                    if recording.trim != nil {
                        Button("Export trimmed copy…") { exportTrimmed() }
                    }
                    Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([model.library.videoURL(for: recording)]) }
                    if recording.transcriptStatus == .ready {
                        Button("Open transcript") { NSWorkspace.shared.open(model.library.transcriptTextURL(for: recording)) }
                        Button("Copy transcript") {
                            if let s = try? String(contentsOf: model.library.transcriptTextURL(for: recording), encoding: .utf8) {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(s, forType: .string)
                            }
                        }
                    }
                    if recording.transcriptStatus != .pending {
                        Button(recording.isMeeting ? "Transcribe with OpenAI" : "Transcribe again") {
                            Publisher.shared.transcribeByUser(recording)
                        }
                    }
                    if recording.upload == .uploaded {
                        Button("Copy transcript JSON URL") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(ShareLinks.downloadURL(shareID: recording.shareID, file: .transcriptJSON).absoluteString, forType: .string)
                        }
                    }
                    Divider()
                    Button("Delete…", role: .destructive, action: delete)
                } label: { Image(systemName: "ellipsis.circle") }
                .menuStyle(.borderlessButton)
                .frame(width: 32)
            }
        }
        .confirmationDialog("Share this meeting video?", isPresented: $confirmMeetingShare) {
            Button("Upload meeting video and create a share link") {
                guard let consent = meetingShareConsent else { return }
                meetingShareConsent = nil
                Publisher.shared.publish(recording, copyLink: true, meetingConsent: consent)
            }
        } message: {
            Text("This uploads the meeting video and transcript to Reel sharing. Anyone allowed by its share settings may access them. Notion notes are delivered separately.")
        }
        .padding(.vertical, 4)
        .task(id: recording.upload == .uploaded) { await Publisher.shared.refreshViews(recording) }
        .contextMenu {
            Button("Rename…", action: rename)
            if recording.upload == .uploaded { Button("Copy link") { Publisher.shared.copyLink(recording) } }
            Button("Delete…", role: .destructive, action: delete)
        }
    }

    private func exportTrimmed() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.mpeg4Movie]
        panel.nameFieldStringValue = "\(recording.title) (trimmed).mp4"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            do {
                try await Publisher.shared.exportTrimmedCopy(recording, to: url)
                NSWorkspace.shared.activateFileViewerSelecting([url])
            } catch { Toast.show("Export failed: \(error.localizedDescription)", isError: true) }
        }
    }

    @ViewBuilder private var thumbnail: some View {
        if recording.hasThumbnail, let img = NSImage(contentsOf: model.library.thumbnailURL(for: recording)) {
            Image(nsImage: img).resizable().aspectRatio(contentMode: .fill).frame(width: 112, height: 63).clipShape(RoundedRectangle(cornerRadius: 6))
        } else {
            RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.15)).frame(width: 112, height: 63)
                .overlay(Image(systemName: "video").foregroundStyle(.secondary))
        }
    }

    @ViewBuilder private var status: some View {
        if recording.discardRequested == true {
            Text("Discard pending").font(.caption).foregroundStyle(.secondary)
        } else if let error = model.captureSaveErrors[recording.id] {
            Text("Video save incomplete").font(.caption).foregroundStyle(.red).help(error)
        } else if recording.captureState == .finalizing {
            Text("Saving video…").font(.caption).foregroundStyle(.secondary)
        } else if let p = model.uploadProgress[recording.id] {
            ProgressView(value: p) { Text("Uploading \(Int(p * 100))%").font(.caption) }.frame(width: 180)
        } else {
            HStack(spacing: 8) {
                if recording.access.isProtected { Image(systemName: "lock.fill").help("Password protected") }
                if let e = recording.access.expiresAt {
                    Text(e <= Date() ? "Expired" : "Expires \(e.formatted(.relative(presentation: .named)))").foregroundStyle(e <= Date() ? .red : .secondary)
                }
                if let t = recording.trim { Text("Trimmed \(Transcript.timestamp(t.start))–\(Transcript.timestamp(t.end))").foregroundStyle(.secondary) }
                if let v = recording.viewCount { Text("\(v) view\(v == 1 ? "" : "s")").foregroundStyle(.secondary) }
                Text(recording.upload.label).foregroundStyle({ if case .failed = recording.upload { return Color.red } else { return Color.secondary } }())
                Text("Transcript: \(recording.transcriptStatus.rawValue)").foregroundStyle(.secondary)
            }
            .font(.caption)
            .lineLimit(1)
        }
    }
}
