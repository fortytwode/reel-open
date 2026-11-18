import AVFoundation
import AVKit
import ReelCore
import SwiftUI

/// Library ▸ Share settings: password protection and link expiry (both enforced by the
/// Firebase rules, see firebase/storage.rules).
struct ShareSettingsView: View {
    @ObservedObject var model: AppModel
    let recordingID: String
    let close: () -> Void
    @State private var protect = false
    @State private var password = ""
    @State private var expiry: ExpiryOption = .never
    @State private var keepExpiry = true
    @State private var working = false
    @State private var error: String?

    private var recording: Recording? { model.recording(id: recordingID) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Share settings").font(.headline)
            if let r = recording {
                Toggle("Require a password", isOn: $protect)
                if protect {
                    SecureField(r.access.isProtected ? "New password (leave empty to keep the current one)" : "Password", text: $password)
                        .textFieldStyle(.roundedBorder)
                    Text("Viewers need the password to watch, read the transcript or see comments. Reel never stores it; if you forget it, set a new one.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 6) {
                    if let e = r.access.expiresAt, keepExpiry {
                        HStack {
                            Text(e <= Date() ? "Link expired \(e.formatted(date: .abbreviated, time: .shortened))" : "Link expires \(e.formatted(date: .abbreviated, time: .shortened))")
                                .foregroundStyle(e <= Date() ? Color.red : Color.secondary)
                            Button("Change") { keepExpiry = false }.buttonStyle(.link)
                        }
                    } else {
                        Picker("Link expires", selection: $expiry) {
                            ForEach(ExpiryOption.allCases, id: \.self) { Text($0 == .never ? "Never" : "In \($0.label)").tag($0) }
                        }
                    }
                }
                if r.upload.mayHaveRemote && (protect != r.access.isProtected || (protect && !password.isEmpty)) {
                    Text("Changing the password re-uploads the video to a new private location and deletes the old copy. The link stays the same.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
                HStack {
                    if working { ProgressView().controlSize(.small) }
                    Spacer()
                    Button("Cancel", action: close).keyboardShortcut(.cancelAction)
                    Button("Save") { save(r) }.keyboardShortcut(.defaultAction).disabled(working || !isValid(r))
                }
            }
        }
        .padding(20)
        .frame(width: 440)
        .onAppear {
            protect = recording?.access.isProtected ?? false
            keepExpiry = recording?.access.expiresAt != nil
        }
    }

    private func isValid(_ r: Recording) -> Bool {
        if protect && !r.access.isProtected { return password.count >= AccessKey.minimumPasswordLength }
        if protect && !password.isEmpty { return password.count >= AccessKey.minimumPasswordLength }
        return true
    }

    private func save(_ r: Recording) {
        let change: Publisher.PasswordChange
        if protect && !password.isEmpty { change = .set(password) }
        else if !protect && r.access.isProtected { change = .remove }
        else { change = .keep }
        let expiresAt = keepExpiry ? r.access.expiresAt : expiry.date()
        working = true
        error = nil
        Task {
            do {
                try await Publisher.shared.updateAccess(r, password: change, expiresAt: expiresAt)
                working = false
                Toast.show(change == .keep ? "Share settings saved" : (protect ? "Password set" : "Password removed"))
                close()
            } catch {
                working = false
                self.error = error.localizedDescription
            }
        }
    }
}

/// Library ▸ Trim: AVKit's own trimming UI (as QuickTime's). The range is applied
/// non-destructively by the viewer, and a trimmed MP4 is uploaded for downloads.
struct TrimView: NSViewRepresentable {
    let url: URL
    let initial: TrimRange?
    let done: (TrimRange?, Bool) -> Void   // (range, cancelled)

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        let item = AVPlayerItem(url: url)
        if let t = initial {
            item.reversePlaybackEndTime = CMTime(seconds: t.start, preferredTimescale: 600)
            item.forwardPlaybackEndTime = CMTime(seconds: t.end, preferredTimescale: 600)
        }
        view.player = AVPlayer(playerItem: item)
        view.controlsStyle = .inline
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            guard view.canBeginTrimming else { return done(nil, true) }
            view.beginTrimming { result in
                guard result == .okButton, let item = view.player?.currentItem else { return done(nil, true) }
                let start = item.reversePlaybackEndTime.isValid ? item.reversePlaybackEndTime.seconds : 0
                let end = item.forwardPlaybackEndTime.isValid ? item.forwardPlaybackEndTime.seconds : item.duration.seconds
                done(TrimRange(start: start, end: end), false)
            }
        }
        return view
    }

    func updateNSView(_ nsView: AVPlayerView, context: Context) {}
}
