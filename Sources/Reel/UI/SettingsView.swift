import AVFoundation
import ReelCore
import ServiceManagement
import Speech
import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @State private var cameras: [AVCaptureDevice] = CaptureDevices.cameras()
    @State private var mics: [AVCaptureDevice] = CaptureDevices.microphones()
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var permissions = Permissions.summary

    var body: some View {
        Form {
            Section("Recording") {
                Picker("Record", selection: $model.settings.mode) {
                    ForEach(CaptureMode.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                Picker("Display", selection: $model.settings.displayID) {
                    Text("Screen with the pointer").tag(UInt32?.none)
                    ForEach(NSScreen.screens, id: \.self) { s in
                        let id = (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
                        Text(s.localizedName).tag(id)
                    }
                }
                .onChange(of: model.settings.displayID) { _, _ in RecorderController.shared.displayChanged() }
                Picker("Countdown", selection: $model.settings.countdownSeconds) {
                    Text("Off").tag(0)
                    ForEach([1, 3, 5], id: \.self) { Text("\($0) s").tag($0) }
                }
                Picker("Quality", selection: $model.settings.quality) {
                    ForEach(QualityPreset.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                Picker("Frame rate", selection: $model.settings.fps) {
                    ForEach([24, 30, 60], id: \.self) { Text("\($0) fps").tag($0) }
                }
                Toggle("Show cursor", isOn: $model.settings.showCursor)
                Toggle("Highlight clicks", isOn: $model.settings.highlightClicks)
            }
            Section("Camera") {
                Toggle("Camera bubble", isOn: $model.settings.cameraEnabled)
                Picker("Camera", selection: $model.settings.cameraID) {
                    Text("Automatic (\(CaptureDevices.defaultCamera(savedID: nil)?.localizedName ?? "none"))").tag(String?.none)
                    ForEach(cameras, id: \.uniqueID) { Text($0.localizedName).tag(Optional($0.uniqueID)) }
                }
                Picker("Bubble size", selection: $model.settings.bubbleSize) {
                    ForEach(BubbleSize.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                }
                Picker("Background", selection: $model.settings.cameraBackground) {
                    ForEach(CameraBackground.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .onChange(of: model.settings.cameraBackground) { _, _ in RecorderController.shared.applyCameraEffect() }
                if model.settings.cameraBackground == .image {
                    LabeledContent("Background image") {
                        HStack {
                            Text(model.settings.backgroundImagePath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "Reel gradient")
                                .foregroundStyle(.secondary).lineLimit(1)
                            Button("Choose…") { chooseBackground() }
                            if model.settings.backgroundImagePath != nil {
                                Button("Default") {
                                    model.settings.backgroundImagePath = nil
                                    RecorderController.shared.applyCameraEffect()
                                }
                            }
                        }
                    }
                }
            }
            Section("Audio") {
                Picker("Audio", selection: $model.settings.audio) {
                    ForEach(AudioSource.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                Picker("Microphone", selection: $model.settings.microphoneID) {
                    Text("Automatic (\(CaptureDevices.defaultMicrophone(savedID: nil)?.localizedName ?? "none"))").tag(String?.none)
                    ForEach(mics, id: \.uniqueID) { Text($0.localizedName).tag(Optional($0.uniqueID)) }
                }
            }
            Section("Transcription") {
                Picker("Language", selection: $model.settings.transcriptionLocaleIdentifier) {
                    ForEach(transcriptionLocales, id: \.identifier) { locale in
                        Text(locale.localizedString(forIdentifier: locale.identifier) ?? locale.identifier)
                            .tag(locale.identifier)
                    }
                }
            }
            Section("Sharing") {
                if let a = model.account {
                    LabeledContent("Signed in", value: a.email)
                    Button("Sign out") { Task { await model.signOut() } }
                } else if CloudConfig.default.isConfigured {
                    Text("Sign in with your organization’s Google account to upload recordings and get share links. Without it, recordings stay on this Mac.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Sign in with Google…") { Task { await model.signIn() } }
                } else {
                    Text("Cloud sharing is not configured. Recordings stay on this Mac.").font(.caption)
                }
                Toggle("Upload automatically when I stop", isOn: $model.settings.autoUpload)
                Toggle("Copy the link and open the recording when I stop", isOn: $model.settings.copyLinkOnStop)
                Toggle("Upload while recording (link plays right after stopping)", isOn: $model.settings.liveUpload)
                Toggle("Also upload an MP4 for downloads", isOn: $model.settings.uploadMP4)
                Toggle("AI title, summary and chapters (on this Mac)", isOn: $model.settings.aiSummary)
            }
            Section("Meetings") { MeetingDeliverySettings() }
            Section("General") {
                ForEach(ShortcutAction.allCases, id: \.self) { ShortcutRecorderRow(model: model, action: $0) }
                Text("Pause, cancel and drawing shortcuts only work while recording.").font(.caption).foregroundStyle(.secondary)
                Toggle("Open at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, on in
                        do { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } }
                        catch { Toast.show("Open at login: \(error.localizedDescription)", isError: true) }
                    }
                LabeledContent("Recordings folder") {
                    Button(model.library.root.path) { NSWorkspace.shared.open(model.library.root) }.buttonStyle(.link)
                }
            }
            Section("Permissions") {
                permissionRow("Screen Recording", permissions["screenRecording"], pane: "Privacy_ScreenCapture")
                permissionRow("Camera", permissions["camera"], pane: "Privacy_Camera")
                permissionRow("Microphone", permissions["microphone"], pane: "Privacy_Microphone")
                Button("Refresh") { permissions = Permissions.summary }
            }
        }
        .formStyle(.grouped)
        .frame(width: 540, height: 760)
        .onAppear {
            cameras = CaptureDevices.cameras()
            mics = CaptureDevices.microphones()
            permissions = Permissions.summary
        }
    }

    private func chooseBackground() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.message = "Choose a virtual background image"
        if panel.runModal() == .OK, let url = panel.url {
            model.settings.backgroundImagePath = url.path
            RecorderController.shared.applyCameraEffect()
        }
    }

    private var transcriptionLocales: [Locale] {
        var identifiers = Set(SFSpeechRecognizer.supportedLocales().map(\.identifier))
        identifiers.insert("en-US")
        identifiers.insert(model.settings.transcriptionLocaleIdentifier)
        return identifiers.map { Locale(identifier: $0) }.sorted {
            let left = $0.localizedString(forIdentifier: $0.identifier) ?? $0.identifier
            let right = $1.localizedString(forIdentifier: $1.identifier) ?? $1.identifier
            return left.localizedCaseInsensitiveCompare(right) == .orderedAscending
        }
    }

    private func permissionRow(_ name: String, _ status: String?, pane: String) -> some View {
        LabeledContent(name) {
            HStack {
                Text(status ?? "unknown").foregroundStyle(status == "granted" ? .green : .orange)
                if status != "granted" { Button("Open Settings") { Permissions.openSettings(pane) } }
            }
        }
    }
}
