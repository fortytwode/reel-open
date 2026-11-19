import AppKit
import ReelCore
import SwiftUI

struct FinishedClipView: View {
    @ObservedObject var model: AppModel
    let id: String
    let recordNext: () -> Void

    @State private var action: ClipAction?
    @State private var title = ""
    @State private var poster: NSImage?

    private enum ClipAction: String, Identifiable {
        case rename, trim, sharing
        var id: Self { self }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let clip = model.recording(id: id), !clip.isMeeting {
                clipHeader(clip)
                    .task(id: clip.hasThumbnail) {
                        poster = clip.hasThumbnail ? NSImage(contentsOf: model.library.thumbnailURL(for: clip)) : nil
                    }
                Divider()
                HStack {
                    Button("Preview") {
                        NSWorkspace.shared.open(model.library.videoURL(for: clip))
                    }
                    .disabled(!isPlayable(clip))
                    if linkAvailable(clip) {
                        Button("Open link") { NSWorkspace.shared.open(clip.shareURL()) }
                        Button("Copy link") { Publisher.shared.copyLink(clip) }
                    } else if isPlayable(clip), case .failed = clip.upload {
                        Button("Retry upload") { Publisher.shared.publish(clip, copyLink: false) }
                            .disabled(model.account == nil || model.uploadProgress[id] != nil)
                    }
                    Spacer()
                }
                HStack {
                    Menu("More") {
                        Button("Rename…") { title = clip.title; action = .rename }
                        Button("Trim…") { action = .trim }.disabled(!isPlayable(clip))
                        Button("Sharing settings…") { action = .sharing }
                            .disabled(!isPlayable(clip) || model.uploadProgress[id] != nil)
                        if clip.awaitsUploadOnSignIn, isPlayable(clip), model.uploadProgress[id] == nil {
                            Button("Upload video") { Publisher.shared.publish(clip, copyLink: false) }
                                .disabled(model.account == nil)
                        }
                        Button("Show in library") { (NSApp.delegate as? AppDelegate)?.showLibrary() }
                    }
                    .fixedSize()
                    Spacer()
                    recordButton
                }
            } else {
                Text("This recording is no longer in the library.").foregroundStyle(.secondary)
                recordButton
            }
        }
        .padding(16)
        .frame(width: 386)
        .sheet(item: $action) { selected in
            if let clip = model.recording(id: id), !clip.isMeeting {
                sheet(for: selected, clip: clip)
            }
        }
    }

    private var recordButton: some View {
        Button(action: recordNext) { Label("Record next", systemImage: "plus") }
            .buttonStyle(.borderedProminent)
            .disabled(model.isBusy)
    }

    private func clipHeader(_ clip: Recording) -> some View {
        HStack(spacing: 12) {
            if let image = poster {
                Image(nsImage: image).resizable().scaledToFill()
                    .frame(width: 76, height: 49).clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                    .accessibilityHidden(true)
            } else {
                Image(systemName: "video").font(.title3).foregroundStyle(.secondary)
                    .frame(width: 76, height: 49)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 7))
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(clip.title).font(.headline).lineLimit(1)
                Text(status(clip)).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                if linkAvailable(clip) {
                    Label(clip.access.isProtected ? "Password protected" : "Anyone with the link",
                          systemImage: clip.access.isProtected ? "lock" : "link")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private func status(_ clip: Recording) -> String {
        if let error = model.captureSaveErrors[id] { return "Save incomplete · \(error)" }
        if clip.captureState == .finalizing { return "Saving video…" }
        if clip.access.isExpired(), clip.upload.mayHaveRemote { return "Share link expired" }
        switch clip.upload {
        case .localOnly: return "Saved on this Mac"
        case .pending: return "Saved on this Mac · Waiting to upload"
        case .uploading: return "Uploading…"
        case .uploaded: return "Link ready"
        case .failed: return "Saved on this Mac · Upload failed"
        }
    }

    private func isPlayable(_ clip: Recording) -> Bool {
        (clip.captureState == .complete || clip.captureState == .recovered)
            && FileManager.default.fileExists(atPath: model.library.videoURL(for: clip).path)
    }

    private func linkAvailable(_ clip: Recording) -> Bool {
        clip.hasPublishableShareID && !clip.access.isExpired() && clip.upload == .uploaded
    }

    @ViewBuilder
    private func sheet(for action: ClipAction, clip: Recording) -> some View {
        switch action {
        case .rename:
            VStack(alignment: .leading, spacing: 12) {
                Text("Rename recording").font(.headline)
                TextField("Title", text: $title)
                HStack {
                    Spacer()
                    Button("Cancel") { self.action = nil }.keyboardShortcut(.cancelAction)
                    Button("Rename") {
                        Publisher.shared.rename(clip, to: title)
                        self.action = nil
                    }
                    .keyboardShortcut(.defaultAction)
                }
            }
            .padding(20).frame(width: 365)
        case .trim:
            VStack(alignment: .leading, spacing: 8) {
                Text("Trim “\(clip.title)”").font(.headline)
                TrimView(url: model.library.videoURL(for: clip), initial: clip.trim) { range, cancelled in
                    self.action = nil
                    if !cancelled {
                        Publisher.shared.setTrim(clip, start: range?.start ?? 0, end: range?.end ?? clip.durationSeconds)
                    }
                }
                .frame(width: 720, height: 440)
            }
            .padding(16)
        case .sharing:
            ShareSettingsView(model: model, recordingID: clip.id) { self.action = nil }
        }
    }
}
