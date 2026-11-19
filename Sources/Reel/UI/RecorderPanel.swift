import AVFoundation
import ReelCore
import ScreenCaptureKit
import SwiftUI

/// Preflight controls shared between the desktop recorder and the meeting popover.
struct RecorderPanel: View {
    @ObservedObject var model: AppModel
    var desktop = false
    var start: (SCWindow?, CGRect?) -> Void
    var signIn: () -> Void
    var copyLastLink: () -> Void

    @State private var devices: (cameras: [DeviceInfo], microphones: [DeviceInfo], defaultMicID: String?)?
    @State private var previewSession: AVCaptureSession?
    @State private var processedFrame: CVPixelBuffer?
    @State private var selectedWindow: SCWindow?
    @State private var selectedArea: CGRect?
    @State private var selectionTask: Task<Void, Never>?
    @State private var selectionError: String?
    @State private var microphoneAccessDenied = false
    @StateObject private var micLevel = MicLevelMonitor()

    private var s: ReelSettings { model.effectiveSettings() }
    private var cameraOn: Bool { s.cameraEnabled || s.mode == .camera }
    private var selectedCamera: DeviceInfo? {
        DeviceDefaults.camera(from: devices?.cameras ?? [], savedID: s.cameraID)
    }
    private var selectedMic: DeviceInfo? {
        DeviceDefaults.microphone(from: devices?.microphones ?? [], savedID: s.microphoneID,
                                  systemDefaultID: devices?.defaultMicID)
    }

    var body: some View {
        Group {
            if desktop {
                desktopControls
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    header
                    meetingForm
                    meetingRecordButton
                    footer
                }
                .padding(16)
                .frame(width: 360)
            }
        }
        .onChange(of: s.mode) { _, _ in selectionError = nil }
        .task(id: model.meetingMode) { await loadRecordingDevices() }
        .task(id: PreviewKey(on: cameraOn && devices != nil, cameraID: s.cameraID)) { await restartPreview() }
        .task(id: MicKey(on: s.audio.usesMic && !model.meetingMode && devices != nil, micID: s.microphoneID)) { await restartMeter() }
        .onDisappear {
            selectionTask?.cancel()
            RecorderController.shared.stopPanelPreview()
            micLevel.stop()
        }
    }

    private var desktopControls: some View {
        HStack(alignment: .top, spacing: 16) {
            if cameraOn {
                cameraPreview.frame(width: 148)
                    .accessibilityLabel("Camera preview")
            }
            VStack(alignment: .leading, spacing: 10) {
                Picker("Capture mode", selection: $model.settings.mode) {
                    Text("Display").tag(CaptureMode.screen)
                    Text("Window").tag(CaptureMode.window)
                    Text("Area").tag(CaptureMode.area)
                    Text("Camera").tag(CaptureMode.camera)
                }
                .pickerStyle(.segmented)
                sourceControls
                if let selectionError {
                    Text(selectionError).font(.caption).foregroundStyle(.secondary)
                }
                Divider()
                HStack(alignment: .top, spacing: 12) {
                    cameraRow.frame(maxWidth: .infinity, alignment: .leading)
                    VStack(alignment: .leading, spacing: 3) {
                        micRow
                        if microphoneAccessDenied && s.audio.usesMic {
                            Text("Microphone access is off")
                                .font(.caption).foregroundStyle(.secondary)
                        } else if !s.audio.usesMic {
                            Text(s.audio.usesSystem ? "Computer sound only" : "Audio off")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Menu {
                        Toggle("Record computer sound", isOn: Binding(get: { s.audio.usesSystem }, set: setSystemAudio))
                        Button("Settings…") { (NSApp.delegate as? AppDelegate)?.showSettings() }
                        Button("Meetings and notes") { (NSApp.delegate as? AppDelegate)?.showMeetingWorkspace() }
                        if model.account == nil { Button("Sign in", action: signIn) }
                    } label: {
                        Label("More options", systemImage: "ellipsis.circle").labelStyle(.iconOnly)
                    }
                    .fixedSize()
                }
                HStack {
                    if s.mode == .window {
                        Text("Includes tabs you switch to in this window.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(action: startDesktopRecording) {
                        Label("Record", systemImage: "record.circle.fill").font(.headline)
                            .padding(.horizontal, 10)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!desktopReady)
                }
            }
        }
        .padding(16)
        .frame(width: 620)
        .disabled(selectionTask != nil)
    }

    private var desktopReady: Bool {
        guard model.phase == .idle else { return false }
        switch s.mode {
        case .window: return selectedWindow != nil
        case .area: return selectedArea != nil
        case .camera: return selectedCamera != nil
        case .screen: return true
        }
    }

    private func startDesktopRecording() {
        guard desktopReady else { return }
        if s.mode == .area, let selectedArea {
            guard NSScreen.screens.contains(where: { $0.frame.contains(selectedArea) }) else {
                self.selectedArea = nil
                selectionError = "That display is unavailable. Select a new area."
                return
            }
            start(nil, selectedArea)
        } else if s.mode == .window, let selectedWindow {
            selectionTask = Task {
                defer { selectionTask = nil }
                do {
                    let current = try await ScreenCapture.refreshedWindow(selectedWindow)
                    guard !Task.isCancelled, model.phase == .idle, s.mode == .window else { return }
                    start(current, nil)
                } catch {
                    guard !Task.isCancelled else { return }
                    self.selectedWindow = nil
                    selectionError = "That window closed or became unavailable. Choose another window."
                }
            }
        } else {
            start(nil, nil)
        }
    }

    @ViewBuilder private var sourceControls: some View {
        switch s.mode {
        case .window:
            HStack {
                Text(selectedWindow.map { $0.title.flatMap { $0.isEmpty ? nil : $0 } ?? $0.owningApplication?.applicationName ?? "Selected window" }
                     ?? "Choose a window")
                    .font(.callout.weight(.medium)).lineLimit(1)
                Spacer()
                Button(selectedWindow == nil ? "Select on desktop" : "Change window") { selectWindow(onDesktop: true) }
                Button("Browse windows") { selectWindow(onDesktop: false) }
            }
        case .area:
            HStack {
                Text(selectedArea.map { "\(Int($0.width)) × \(Int($0.height)) area" } ?? "Choose an area")
                    .font(.callout.weight(.medium))
                Spacer()
                Button(selectedArea == nil ? "Select area" : "Change area") { selectArea() }
            }
        case .screen:
            displayRow
        case .camera:
            Label("Camera only", systemImage: "person.crop.square").font(.callout.weight(.medium))
        }
    }

    private func selectWindow(onDesktop: Bool) {
        selectionError = nil
        selectionTask = Task {
            defer { selectionTask = nil }
            do {
                let content = try await ScreenCapture.shareableContent()
                guard !Task.isCancelled, model.phase == .idle, s.mode == .window else { return }
                let items = WindowPicker.candidates(content)
                if onDesktop && !items.contains(where: { $0.window.isOnScreen }) {
                    selectionError = "No windows are visible on this desktop. Browse windows to see other Spaces."
                    return
                }
                let target = if onDesktop { await WindowPicker.pickOnDesktop(items: items) } else { await WindowPicker.pick(items: items) }
                guard !Task.isCancelled, model.phase == .idle, s.mode == .window else { return }
                if let target {
                    selectedWindow = try await ScreenCapture.refreshedWindow(target)
                    guard !Task.isCancelled, model.phase == .idle, s.mode == .window else { selectedWindow = nil; return }
                } else if items.isEmpty {
                    selectionError = "No recordable windows are open."
                }
            } catch {
                guard !Task.isCancelled else { return }
                selectedWindow = nil
                selectionError = "The window is unavailable. Check Screen Recording access or choose another window."
            }
        }
    }

    private func selectArea() {
        selectionError = nil
        selectionTask = Task {
            defer { selectionTask = nil }
            guard let newArea = await AreaSelector.select(previous: s.lastArea?.cg), !Task.isCancelled,
                  model.phase == .idle, s.mode == .area else { return }
            selectedArea = newArea.rect
            model.settings.lastArea = Rect(newArea.rect)
        }
    }

    // MARK: Sections

    private var meetingForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Meeting title", text: $model.meetingTitle)
                .textFieldStyle(.roundedBorder)
            TextField("Attendee emails (comma separated)", text: $model.meetingAttendees)
                .textFieldStyle(.roundedBorder)
            if model.meetingCalendarOccurrenceID != nil {
                Text("Recap recipients come from the selected calendar invitation.").font(.caption)
                Button("Use as a manual meeting instead") {
                    model.meetingCalendarReference = nil; model.meetingCalendarOccurrenceID = nil
                }.font(.caption)
            }
            Text("Records the selected meeting window, computer sound, and microphone. Video stays on this Mac. Audio is sent securely to OpenAI; notes go to Notion and internal calendar invitees. Manual meetings without a calendar invitation send a recap only to you.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Toggle("Include my microphone", isOn: $model.meetingMicrophoneEnabled)
                .font(.callout)
            Button("Calendar meetings and automatic joining…") {
                (NSApp.delegate as? AppDelegate)?.showMeetings()
            }
        }
    }

    private var meetingRecordButton: some View {
        Button { start(nil, nil) } label: {
            HStack(spacing: 8) {
                Image(systemName: "record.circle")
                Text("Start Meeting Recording").font(.headline)
                Spacer()
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(.white)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.red))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .keyboardShortcut(.defaultAction)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "record.circle.fill").font(.system(size: 22)).foregroundStyle(.red)
            Text("Reel").font(.title3.weight(.semibold))
            Spacer()
            if let account = model.account {
                Text(account.displayName ?? account.email).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            } else {
                Button("Sign in", action: signIn).controlSize(.small)
            }
        }
    }

    private var cameraPreview: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12).fill(Color.black.opacity(0.85))
            if cameraOn, let previewSession {
                CameraPreviewView(session: previewSession, processed: processedFrame)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "video.slash").font(.system(size: 26))
                    if cameraOn {
                        if [.denied, .restricted].contains(AVCaptureDevice.authorizationStatus(for: .video)) {
                            Text("Camera access is off").font(.callout)
                        } else {
                            Text(devices?.cameras.isEmpty == true ? "No camera found" : "Starting camera…").font(.callout)
                        }
                    } else {
                        Text("Camera is off").font(.callout)
                        Button("Turn camera on") { setCamera(selectedCamera?.id) }
                            .controlSize(.small)
                            .disabled(devices == nil)
                    }
                }
                .foregroundStyle(.white.opacity(0.75))
            }
        }
        .frame(height: 186)
    }

    private var displayRow: some View {
        row(symbol: "display.2", on: true) {
            Menu {
                Button("Screen with the pointer") { setDisplay(nil) }
                ForEach(NSScreen.screens, id: \.self) { screen in
                    Button(screen.localizedName) { setDisplay(RecorderController.displayID(of: screen)) }
                }
            } label: {
                Text(s.displayID.flatMap { id in NSScreen.screens.first { RecorderController.displayID(of: $0) == id }?.localizedName }
                     ?? "Screen with the pointer")
            }
        } trailing: { EmptyView() }
    }

    private var cameraRow: some View {
        row(symbol: cameraOn ? "video.fill" : "video.slash", on: cameraOn) {
            Menu {
                ForEach(devices?.cameras ?? []) { cam in Button(cam.name) { setCamera(cam.id) } }
            } label: {
                Text(cameraOn ? (selectedCamera?.name ?? (devices == nil ? "Loading cameras…" : "No camera found")) : "No camera")
            }
        } trailing: {
            if s.mode != .camera {
                Toggle("", isOn: Binding(get: { s.cameraEnabled },
                                         set: { $0 ? setCamera(selectedCamera?.id) : setCamera(nil) }))
                    .toggleStyle(.switch).controlSize(.mini).labelsHidden().help("Camera on / off")
                    .disabled(devices == nil)
            }
        }
    }

    private var micRow: some View {
        row(symbol: s.audio.usesMic ? "mic.fill" : "mic.slash", on: s.audio.usesMic) {
            VStack(alignment: .leading, spacing: 3) {
                Menu {
                    ForEach(devices?.microphones ?? []) { mic in
                        Button(mic.name) {
                            model.settings.microphoneID = mic.id
                            setMic(true)
                        }
                    }
                } label: {
                    Text(s.audio.usesMic ? (selectedMic?.name ?? (devices == nil ? "Loading microphones…" : "No microphone found")) : "No microphone")
                }
                if s.audio.usesMic { LevelMeter(level: micLevel.level) }
            }
        } trailing: {
            Toggle("", isOn: Binding(get: { s.audio.usesMic }, set: { setMic($0) }))
                .toggleStyle(.switch).controlSize(.mini).labelsHidden().help("Microphone on / off")
        }
    }

    private var footer: some View {
        HStack {
            Button("Screen recording") {
                (NSApp.delegate as? AppDelegate)?.showScreenRecordingPanel()
            }.buttonStyle(.link)
            Spacer()
            if let last = model.recordings.first, last.upload == .uploaded {
                Button("Copy last link", action: copyLastLink).buttonStyle(.link)
            }

        }
        .font(.callout)
    }

    // MARK: Actions

    private func loadRecordingDevices() async {
        // The meeting form uses neither list, and cold camera discovery can block.
        guard !model.meetingMode, devices == nil, !Task.isCancelled else { return }
        let discovered = await Task.detached(priority: .userInitiated) {
            (CaptureDevices.cameras().map(CaptureDevices.info),
             CaptureDevices.microphones().map(CaptureDevices.info),
             AVCaptureDevice.default(for: .audio)?.uniqueID)
        }.value
        guard !Task.isCancelled, !model.meetingMode else { return }
        devices = discovered
    }

    private func restartPreview() async {
        processedFrame = nil
        guard cameraOn, devices != nil else {
            previewSession = nil
            RecorderController.shared.stopPanelPreview()
            return
        }
        RecorderController.shared.panelFrameSink = { buffer in processedFrame = buffer }
        previewSession = await RecorderController.shared.startPanelPreview()
    }

    private func restartMeter() async {
        micLevel.stop()
        microphoneAccessDenied = false
        guard !model.meetingMode, s.audio.usesMic, devices != nil,
              let mic = CaptureDevices.defaultMicrophone(savedID: s.microphoneID) else { return }
        let granted = await Permissions.request(.audio)
        guard !Task.isCancelled, model.phase == .idle,
              !model.meetingMode, s.audio.usesMic,
              CaptureDevices.defaultMicrophone(savedID: s.microphoneID)?.uniqueID == mic.uniqueID else { return }
        microphoneAccessDenied = !granted
        if granted { micLevel.start(device: mic) }
    }

    private func setCamera(_ id: String?) {
        if let id {
            model.settings.cameraEnabled = true
            model.settings.cameraID = id
            if RecorderController.shared.isBubbleVisible { RecorderController.shared.showBubble() }
        } else {
            model.settings.cameraEnabled = false
            RecorderController.shared.hideBubble()
        }
    }

    private func setMic(_ on: Bool) {
        let system = model.settings.audio.usesSystem
        model.settings.audio = on ? (system ? .micAndSystem : .micOnly) : (system ? .systemOnly : .none)
    }

    private func setSystemAudio(_ on: Bool) {
        let mic = model.settings.audio.usesMic
        model.settings.audio = on ? (mic ? .micAndSystem : .systemOnly) : (mic ? .micOnly : .none)
    }

    private func setDisplay(_ id: UInt32?) {
        model.settings.displayID = id
        RecorderController.shared.displayChanged()
    }

    // MARK: Helpers

    private func row<Content: View, Trailing: View>(symbol: String, on: Bool, @ViewBuilder content: () -> Content,
                                                    @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).frame(width: 20).foregroundStyle(on ? Color.primary : Color.secondary)
            content().menuStyle(.borderlessButton).frame(maxWidth: .infinity, alignment: .leading)
            trailing()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(minHeight: 34)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
    }

    private struct PreviewKey: Equatable { var on: Bool; var cameraID: String? }
    private struct MicKey: Equatable { var on: Bool; var micID: String? }
}

/// Mirrored live camera preview; shows effect-processed frames (blur / virtual background) when present.
private struct CameraPreviewView: NSViewRepresentable {
    let session: AVCaptureSession
    let processed: CVPixelBuffer?

    func makeNSView(context: Context) -> PreviewNSView { PreviewNSView(session: session) }

    func updateNSView(_ view: PreviewNSView, context: Context) {
        if view.preview.session !== session { view.preview.session = session }
        view.show(processed)
    }

    final class PreviewNSView: NSView {
        let preview: AVCaptureVideoPreviewLayer
        private let effectLayer = CALayer()

        init(session: AVCaptureSession) {
            preview = AVCaptureVideoPreviewLayer(session: session)
            super.init(frame: .zero)
            wantsLayer = true
            preview.videoGravity = .resizeAspectFill
            if let connection = preview.connection, connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = true
            }
            effectLayer.contentsGravity = .resizeAspectFill
            effectLayer.setAffineTransform(CGAffineTransform(scaleX: -1, y: 1))   // mirrored like the preview
            effectLayer.isHidden = true
            layer?.addSublayer(preview)
            layer?.addSublayer(effectLayer)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func layout() {
            super.layout()
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            preview.frame = bounds
            effectLayer.frame = bounds
            CATransaction.commit()
        }

        func show(_ buffer: CVPixelBuffer?) {
            effectLayer.contents = buffer.map { CIImage(cvPixelBuffer: $0) }.flatMap { Self.context.createCGImage($0, from: $0.extent) }
            effectLayer.isHidden = buffer == nil
        }

        private static let context = CIContext()
    }
}

/// Thin horizontal input level bar.
private struct LevelMeter: View {
    let level: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.1))
                Capsule().fill(level > 0.85 ? Color.orange : Color.green)
                    .frame(width: max(2, geo.size.width * level))
            }
        }
        .frame(height: 4)
        .animation(.linear(duration: 0.08), value: level)
    }
}

/// Live microphone level (0…1) for the panel's meter, from its own short-lived capture session.
@MainActor
final class MicLevelMonitor: ObservableObject {
    @Published private(set) var level: Double = 0
    private var capture: MicCapture?

    func start(device: AVCaptureDevice) {
        stop()
        let capture = MicCapture { [weak self] buffer, _ in
            let value = Self.rms(buffer)
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.level = value } }
        }
        do { try capture.start(device: device) } catch { return }
        self.capture = capture
    }

    func stop() {
        capture?.stop()
        capture = nil
        level = 0
    }

    /// RMS of float32 mono PCM mapped to 0…1 on a -50…0 dB scale.
    nonisolated private static func rms(_ buffer: CMSampleBuffer) -> Double {
        guard let block = CMSampleBufferGetDataBuffer(buffer) else { return 0 }
        var length = 0
        var pointer: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
              let pointer, length >= 4 else { return 0 }
        let count = length / 4
        let samples = UnsafeRawPointer(pointer).bindMemory(to: Float.self, capacity: count)
        var sum: Float = 0
        for i in 0..<count { sum += samples[i] * samples[i] }
        let rms = sqrt(sum / Float(count))
        let db = 20 * log10(max(rms, 1e-6))
        return Double(min(1, max(0, (db + 50) / 50)))
    }
}
