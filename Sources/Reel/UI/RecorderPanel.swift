import AVFoundation
import ReelCore
import SwiftUI

/// The idle menu bar popover, laid out like Loom's recorder: live camera preview, what to record,
/// camera and mic (with a level meter), system audio, recording settings, and one big record button.
/// While recording, the status item shows the plain control menu instead.
struct RecorderPanel: View {
    @ObservedObject var model: AppModel
    var start: () -> Void
    var signIn: () -> Void
    var copyLastLink: () -> Void

    @State private var cameras: [AVCaptureDevice] = CaptureDevices.cameras()
    @State private var microphones: [AVCaptureDevice] = CaptureDevices.microphones()
    @State private var previewSession: AVCaptureSession?
    @State private var processedFrame: CVPixelBuffer?
    @State private var showSettings = false
    @StateObject private var micLevel = MicLevelMonitor()

    private var s: ReelSettings { model.effectiveSettings() }
    private var cameraOn: Bool { s.cameraEnabled || s.mode == .camera }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            modePicker
            if model.meetingMode {
                meetingForm
                meetingRecordButton
            } else {
                cameraPreview
                modeTiles
                if NSScreen.screens.count > 1 && s.mode != .camera { displayRow }
                cameraRow
                micRow
                systemAudioRow
                recordButton
                settingsSection
            }
            footer
        }
        .padding(16)
        .frame(width: 360)
        .task(id: PreviewKey(on: cameraOn, cameraID: s.cameraID)) { await restartPreview() }
        .task(id: MicKey(on: s.audio.usesMic && !model.meetingMode, micID: s.microphoneID)) { restartMeter() }
        .onDisappear {
            RecorderController.shared.stopPanelPreview()
            micLevel.stop()
        }
    }

    // MARK: Sections

    private var modePicker: some View {
        Picker("Recording type", selection: $model.meetingMode) {
            Text("Recording").tag(false)
            Text("Meeting").tag(true)
        }
        .pickerStyle(.segmented)
        .onChange(of: model.meetingMode) { _, meeting in
            if !meeting { model.meetingCalendarReference = nil; model.meetingCalendarOccurrenceID = nil }
        }
    }

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
        Button(action: start) {
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
                        Text(cameras.isEmpty ? "No camera found" : "Starting camera…").font(.callout)
                    } else {
                        Text("Camera is off").font(.callout)
                        Button("Turn camera on") { setCamera(CaptureDevices.defaultCamera(savedID: s.cameraID)?.uniqueID) }
                            .controlSize(.small)
                    }
                }
                .foregroundStyle(.white.opacity(0.75))
            }
        }
        .frame(height: 186)
    }

    private var modeTiles: some View {
        HStack(spacing: 8) {
            ForEach(CaptureMode.allCases, id: \.self) { mode in
                Button { model.settings.mode = mode } label: {
                    VStack(spacing: 5) {
                        Image(systemName: symbol(for: mode)).font(.system(size: 18))
                        Text(mode.label).font(.caption).lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(RoundedRectangle(cornerRadius: 10).fill(s.mode == mode ? Color.accentColor.opacity(0.18) : Color.primary.opacity(0.05)))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(s.mode == mode ? Color.accentColor : .clear, lineWidth: 1.5))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(mode.label)
            }
        }
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
                ForEach(cameras, id: \.uniqueID) { cam in Button(cam.localizedName) { setCamera(cam.uniqueID) } }
            } label: {
                Text(cameraOn ? (CaptureDevices.defaultCamera(savedID: s.cameraID)?.localizedName ?? "No camera found") : "No camera")
            }
        } trailing: {
            if s.mode != .camera {
                Toggle("", isOn: Binding(get: { s.cameraEnabled },
                                         set: { $0 ? setCamera(CaptureDevices.defaultCamera(savedID: s.cameraID)?.uniqueID) : setCamera(nil) }))
                    .toggleStyle(.switch).controlSize(.mini).labelsHidden().help("Camera on / off")
            }
        }
    }

    private var micRow: some View {
        row(symbol: s.audio.usesMic ? "mic.fill" : "mic.slash", on: s.audio.usesMic) {
            VStack(alignment: .leading, spacing: 3) {
                Menu {
                    ForEach(microphones, id: \.uniqueID) { mic in
                        Button(mic.localizedName) {
                            model.settings.microphoneID = mic.uniqueID
                            setMic(true)
                        }
                    }
                } label: {
                    Text(s.audio.usesMic ? (CaptureDevices.defaultMicrophone(savedID: s.microphoneID)?.localizedName ?? "No microphone found") : "No microphone")
                }
                if s.audio.usesMic { LevelMeter(level: micLevel.level) }
            }
        } trailing: {
            Toggle("", isOn: Binding(get: { s.audio.usesMic }, set: { setMic($0) }))
                .toggleStyle(.switch).controlSize(.mini).labelsHidden().help("Microphone on / off")
        }
    }

    private var systemAudioRow: some View {
        row(symbol: s.audio.usesSystem ? "speaker.wave.2.fill" : "speaker.slash", on: s.audio.usesSystem) {
            Text("Record computer sound").frame(maxWidth: .infinity, alignment: .leading)
        } trailing: {
            Toggle("", isOn: Binding(get: { s.audio.usesSystem }, set: { setSystemAudio($0) }))
                .toggleStyle(.switch).controlSize(.mini).labelsHidden().help("System audio on / off")
        }
    }

    private var recordButton: some View {
        Button(action: start) {
            HStack(spacing: 8) {
                Image(systemName: "record.circle")
                Text("Start Recording").font(.headline)
                Spacer()
                Text(s.shortcut.display).font(.callout).opacity(0.8)
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

    private var settingsSection: some View {
        DisclosureGroup(isExpanded: $showSettings) {
            VStack(spacing: 8) {
                labeled("Countdown") {
                    Picker("", selection: $model.settings.countdownSeconds) {
                        Text("Off").tag(0)
                        ForEach([1, 3, 5], id: \.self) { Text("\($0) s").tag($0) }
                    }
                }
                labeled("Quality") {
                    Picker("", selection: $model.settings.quality) {
                        ForEach(QualityPreset.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                }
                labeled("Camera background") {
                    Picker("", selection: $model.settings.cameraBackground) {
                        ForEach(CameraBackground.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    .onChange(of: model.settings.cameraBackground) { _, _ in RecorderController.shared.applyCameraEffect() }
                }
                labeled("Bubble size") {
                    Picker("", selection: $model.settings.bubbleSize) {
                        ForEach(BubbleSize.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                    }
                }
                Toggle("Highlight mouse clicks", isOn: $model.settings.highlightClicks)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Toggle("Show cursor", isOn: $model.settings.showCursor)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.top, 6)
        } label: {
            Text("Recording settings").font(.callout.weight(.medium))
        }
    }

    private var footer: some View {
        HStack {
            Button("Meetings and notes") {
                (NSApp.delegate as? AppDelegate)?.showMeetingWorkspace()
            }.buttonStyle(.link)
            Spacer()
            if let last = model.recordings.first, last.upload == .uploaded {
                Button("Copy last link", action: copyLastLink).buttonStyle(.link)
            }

        }
        .font(.callout)
    }

    // MARK: Actions

    private func restartPreview() async {
        processedFrame = nil
        guard cameraOn else {
            previewSession = nil
            RecorderController.shared.stopPanelPreview()
            return
        }
        RecorderController.shared.panelFrameSink = { buffer in processedFrame = buffer }
        previewSession = await RecorderController.shared.startPanelPreview()
    }

    private func restartMeter() {
        micLevel.stop()
        guard !model.meetingMode, s.audio.usesMic,
              let mic = CaptureDevices.defaultMicrophone(savedID: s.microphoneID) else { return }
        Task {
            guard await Permissions.request(.audio) else { return }
            micLevel.start(device: mic)
        }
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

    private func symbol(for mode: CaptureMode) -> String {
        switch mode {
        case .screen: "display"
        case .window: "macwindow"
        case .area: "rectangle.dashed"
        case .camera: "person.crop.square"
        }
    }

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

    private func labeled<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack {
            Text(title)
            Spacer()
            content().labelsHidden().fixedSize()
        }
    }

    private func iconButton(_ symbol: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol) }.buttonStyle(.borderless).help(help)
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
