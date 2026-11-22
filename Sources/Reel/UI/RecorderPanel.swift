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
    static let desktopWidth: CGFloat = 724
    var recorderWindow: () -> NSWindow? = { nil }
    var setDesktopSelection: (CaptureMode?) -> Void = { _ in }
    var setPanelHeight: (CGFloat) -> Void = { _ in }

    @State private var devices: (cameras: [DeviceInfo], microphones: [DeviceInfo], defaultMicID: String?)?
    @State private var previewSession: AVCaptureSession?
    @State private var processedFrame: CVPixelBuffer?
    @State private var selectedWindow: SCWindow?
    @State private var selectedArea: CGRect?
    @State private var selectionTask: Task<Void, Never>?
    @State private var choosingWindow = false
    @State private var openingBrowserTab = false
    @State private var selectionError: String?
    @State private var micAccess = Permissions.status(.audio)
    @State private var needsScreenAccess = false
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
        .onChange(of: s.mode) { _, _ in
            selectionError = nil
            needsScreenAccess = false
        }
        .task(id: model.meetingMode) { await loadRecordingDevices() }
        .task(id: PreviewKey(on: cameraOn && devices != nil, cameraID: s.cameraID)) { await restartPreview() }
        .task(id: MicKey(on: s.audio.usesMic && micAccess == .authorized && devices != nil, micID: s.microphoneID)) { restartMeter() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            micAccess = Permissions.status(.audio)
            if needsScreenAccess && Permissions.screenRecording {
                needsScreenAccess = false
                selectionError = nil
            }
        }
        .onDisappear {
            cancelSourceSelection()
            RecorderController.shared.stopPanelPreview()
            micLevel.stop()
        }
    }

    private let recorderInk = ReelPanelPalette.ink
    private let recorderAccent = ReelPanelPalette.mint

    private var desktopControls: some View {
        VStack(alignment: .leading, spacing: 0) {
            if cameraOn {
                cameraPreview.frame(width: 176)
                    .accessibilityLabel("Camera preview")
                    .padding([.top, .leading], 14)
            }
            HStack(spacing: 10) {
                captureModes
                Spacer(minLength: 6)
                deviceButton(cameraOn ? "Camera on" : "Camera off", symbol: cameraOn ? "video.fill" : "video.slash",
                             active: cameraOn) { setCamera(cameraOn ? nil : selectedCamera?.id) }
                    .disabled(s.mode == .camera || selectedCamera == nil)
                deviceButton(s.audio.usesMic ? "Microphone on" : "Microphone off", symbol: s.audio.usesMic ? "mic.fill" : "mic.slash",
                             active: s.audio.usesMic) { setMic(!s.audio.usesMic) }
                sharingOptions
                recordingEffects
                recorderOptions
                Button(action: startDesktopRecording) {
                    Label("Record", systemImage: "record.circle.fill")
                        .font(.callout.weight(.bold))
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 13)
                        .frame(height: 40)
                        .foregroundStyle(recorderInk)
                        .background(recorderAccent, in: RoundedRectangle(cornerRadius: 9))
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.defaultAction)
                .disabled(!desktopReady)
                .opacity(desktopReady ? 1 : 0.45)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)

            Divider().overlay(.white.opacity(0.1))
            HStack(spacing: 12) {
                sourceControls
                Spacer(minLength: 0)
                Label(audioStatus, systemImage: s.audio.usesMic ? "mic" : (s.audio.usesSystem ? "speaker.wave.2" : "mic.slash"))
                    .lineLimit(1)
                    .help(audioStatus)
                if s.audio.usesMic && micAccess == .authorized {
                    LevelMeter(level: micLevel.level)
                        .frame(width: 45)
                        .accessibilityLabel("Microphone input level")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 16)
            .frame(minHeight: 36)

            if let selectionError {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
                    Text(selectionError).fixedSize(horizontal: false, vertical: true)
                    if needsScreenAccess {
                        Button("Open Screen Recording Settings") { Permissions.openSettings("Privacy_ScreenCapture") }
                            .buttonStyle(.link)
                    }
                }
                .font(.caption)
                .padding(.horizontal, 16)
                .padding(.bottom, 10)
            }
        }
        .frame(width: Self.desktopWidth)
        .fixedSize(horizontal: false, vertical: true)
        .background(recorderInk)
        .environment(\.colorScheme, .dark)
        .disabled(openingBrowserTab)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { setPanelHeight($0) }
    }

    private var captureModes: some View {
        HStack(spacing: 3) {
            ForEach(CaptureMode.allCases, id: \.self) { mode in
                let selected = s.mode == mode
                Button { chooseMode(mode) } label: {
                    Label(modeTitle(mode), systemImage: modeSymbol(mode))
                        .font(.caption.weight(.semibold))
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 8)
                        .frame(height: 34)
                        .foregroundStyle(selected ? recorderAccent : Color.white.opacity(0.78))
                        .background(selected ? Color.white.opacity(0.11) : .clear, in: RoundedRectangle(cornerRadius: 7))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
                if mode == .window, let url = CloudConfig.default.browserTabRecorderURL {
                    Button { openBrowserTabRecorder(url) } label: {
                        Label("Tab", systemImage: "arrow.up.right.square")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 6)
                            .frame(height: 34)
                    }
                    .buttonStyle(.plain)
                    .help("Open the browser recorder to capture a single tab")
                    .accessibilityLabel("Record a browser tab")
                }
            }
        }
        .padding(3)
        .background(.black.opacity(0.32), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Capture mode")
    }

    private func openBrowserTabRecorder(_ url: URL) {
        guard !openingBrowserTab else { return }
        cancelSourceSelection()
        let workspace = NSWorkspace.shared
        let browsers = ["com.google.Chrome", "com.microsoft.edgemac"]
        let preferred = workspace.urlForApplication(toOpen: url)
        let browser = preferred.flatMap { url in
            browsers.contains(Bundle(url: url)?.bundleIdentifier ?? "") ? url : nil
        } ?? browsers.lazy.compactMap { workspace.urlForApplication(withBundleIdentifier: $0) }.first
        guard let browser else {
            selectionError = "Tab recording requires Google Chrome or Microsoft Edge."
            return
        }
        openingBrowserTab = true
        selectionTask = Task {
            defer {
                openingBrowserTab = false
                if !Task.isCancelled { selectionTask = nil }
            }
            do {
                _ = try await workspace.open([url], withApplicationAt: browser, configuration: NSWorkspace.OpenConfiguration())
                if !Task.isCancelled { recorderWindow()?.close() }
            } catch {
                if !Task.isCancelled { selectionError = "Couldn’t open the browser recorder." }
            }
        }
    }

    private func modeTitle(_ mode: CaptureMode) -> String {
        switch mode {
        case .screen: "Screen"
        case .window: "Window"
        case .area: "Area"
        case .camera: "Camera"
        }
    }

    private func modeSymbol(_ mode: CaptureMode) -> String {
        switch mode {
        case .screen: "display"
        case .window: "macwindow"
        case .area: "rectangle.dashed"
        case .camera: "person.crop.rectangle"
        }
    }

    private func deviceButton(_ title: String, symbol: String, active: Bool,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .labelStyle(.iconOnly)
                .font(.system(size: 16, weight: .medium))
                .frame(width: 33, height: 36)
                .foregroundStyle(active ? recorderAccent : Color.white.opacity(0.68))
                .background(active ? recorderAccent.opacity(0.11) : .clear, in: RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
        .help(title)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private var sharingOptions: some View {
        Menu {
            if model.account != nil {
                Picker("Save recordings", selection: $model.settings.autoUpload) {
                    Text("On this Mac only").tag(false)
                    Text("Upload for a share link").tag(true)
                }
                .pickerStyle(.inline)
                Toggle("Copy link when I stop", isOn: $model.settings.copyLinkOnStop)
                    .disabled(!s.autoUpload)
            } else {
                Text("Recordings are saved on this Mac.")
                if CloudConfig.default.isConfigured {
                    Button("Sign in to share recordings…") { cancelSourceSelection(); signIn() }
                }
            }
        } label: {
            Label("Sharing", systemImage: (model.account != nil && s.autoUpload) ? "link" : "lock")
                .labelStyle(.iconOnly)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Sharing and local saving")
    }

    private var recordingEffects: some View {
        Menu {
            Picker("Camera background", selection: $model.settings.cameraBackground) {
                ForEach(CameraBackground.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            Picker("Camera bubble size", selection: $model.settings.bubbleSize) {
                ForEach(BubbleSize.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
            }
            Toggle("Show cursor", isOn: $model.settings.showCursor)
            Toggle("Highlight clicks", isOn: $model.settings.highlightClicks)
        } label: {
            Label("Recording effects", systemImage: "wand.and.stars").labelStyle(.iconOnly)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Camera background, bubble size and cursor effects")
        .onChange(of: s.cameraBackground) { _, _ in RecorderController.shared.applyCameraEffect() }
    }

    private var recorderOptions: some View {
        Menu {
            Section("Microphone") {
                ForEach(devices?.microphones ?? []) { mic in
                    Button(mic.name) { model.settings.microphoneID = mic.id; setMic(true) }
                }
                Button("Turn microphone off") { setMic(false) }
                if s.audio.usesMic && micAccess == .denied {
                    Button("Microphone Settings…") {
                        cancelSourceSelection()
                        Permissions.openSettings("Privacy_Microphone")
                    }
                }
            }
            Section("Camera") {
                ForEach(devices?.cameras ?? []) { cam in Button(cam.name) { setCamera(cam.id) } }
                if s.mode != .camera { Button("Turn camera off") { setCamera(nil) } }
            }
            Toggle("Record computer sound", isOn: Binding(get: { s.audio.usesSystem }, set: setSystemAudio))
            Divider()
            Button("Screen Recordings…") { cancelSourceSelection(); (NSApp.delegate as? AppDelegate)?.showLibrary() }
            if CloudConfig.default.notetakerURL != nil {
                Button("Open Reel Notetaker…") { cancelSourceSelection(); (NSApp.delegate as? AppDelegate)?.openNotetaker() }
            }
            Button("Settings…") { cancelSourceSelection(); (NSApp.delegate as? AppDelegate)?.showSettings() }
            if model.account == nil { Button("Sign in") { cancelSourceSelection(); signIn() } }
        } label: {
            Label("Recording options", systemImage: "ellipsis").labelStyle(.iconOnly)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private var audioStatus: String {
        if s.audio.usesMic {
            if micAccess != .authorized { return "Mic access needed" }
            let name = selectedMic?.name ?? "No mic found"
            return s.audio.usesSystem ? "\(name) + computer sound" : name
        }
        return s.audio.usesSystem ? "Computer sound only" : "Audio off"
    }

    private func chooseMode(_ mode: CaptureMode) {
        cancelSourceSelection()
        selectionError = nil
        needsScreenAccess = false
        model.settings.mode = mode
        switch mode {
        case .window: selectWindow(onDesktop: true)
        case .area: selectArea()
        case .screen, .camera: break
        }
    }

    private func cancelSourceSelection() {
        guard let selectionTask else { return }
        selectionTask.cancel()
        WindowPicker.cancelSelection()
        AreaSelector.cancelSelection()
        self.selectionTask = nil
        choosingWindow = false
        setDesktopSelection(nil)
    }

    private var desktopReady: Bool {
        guard selectionTask == nil, model.phase == .idle else { return false }
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
                defer { if !Task.isCancelled { selectionTask = nil } }
                do {
                    let current = try await ScreenCapture.refreshedWindow(selectedWindow)
                    guard !Task.isCancelled, recorderWindow()?.isVisible == true,
                          model.phase == .idle, s.mode == .window else { return }
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
            if choosingWindow {
                Button("Cancel", action: cancelSourceSelection).buttonStyle(.link)
            } else if let selectedWindow {
                let name = selectedWindow.title.flatMap { $0.isEmpty ? nil : $0 }
                    ?? selectedWindow.owningApplication?.applicationName ?? "Selected window"
                Label(name, systemImage: "macwindow")
                    .lineLimit(1)
                    .help("\(name). Records the whole window, including tabs you switch to.")
            } else {
                Text("Click Window to pick a window.")
            }
            Button("Browse windows…") {
                if !WindowPicker.browseWindows() { selectWindow(onDesktop: false) }
            }
            .buttonStyle(.link)
        case .area:
            if let selectedArea {
                Label("\(Int(selectedArea.width)) × \(Int(selectedArea.height)) area", systemImage: "rectangle.dashed")
            } else {
                Text("Click Area to select a region.")
            }
        case .screen:
            Menu {
                Button("Screen with the pointer") { setDisplay(nil) }
                ForEach(NSScreen.screens, id: \.self) { screen in
                    Button(screen.localizedName) { setDisplay(RecorderController.displayID(of: screen)) }
                }
            } label: {
                Label(s.displayID.flatMap { id in NSScreen.screens.first { RecorderController.displayID(of: $0) == id }?.localizedName }
                      ?? "Screen with the pointer", systemImage: "display")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        case .camera:
            Label(selectedCamera?.name ?? "No camera found", systemImage: "video").lineLimit(1)
        }
    }

    private func selectWindow(onDesktop: Bool) {
        cancelSourceSelection()
        choosingWindow = true
        selectionError = nil
        needsScreenAccess = false
        selectionTask = Task {
            defer {
                if !Task.isCancelled {
                    choosingWindow = false
                    selectionTask = nil
                    setDesktopSelection(nil)
                }
            }
            do {
                let content = try await ScreenCapture.shareableContent()
                guard !Task.isCancelled, recorderWindow()?.isVisible == true,
                      model.phase == .idle, s.mode == .window else { return }
                let items = WindowPicker.candidates(content)
                guard !items.isEmpty else {
                    selectionError = "Open a window to record, then try again."
                    return
                }
                if onDesktop { setDesktopSelection(.window) }
                let target = if onDesktop {
                    await WindowPicker.pickOnDesktop(items: items, keepingAbove: recorderWindow())
                } else {
                    await WindowPicker.pick(items: items)
                }
                guard !Task.isCancelled, model.phase == .idle, s.mode == .window else { return }
                if let target {
                    let current = try await ScreenCapture.refreshedWindow(target)
                    guard !Task.isCancelled, model.phase == .idle, s.mode == .window else { return }
                    selectedWindow = current
                }
            } catch {
                guard !Task.isCancelled else { return }
                selectedWindow = nil
                let captureError = error as NSError
                needsScreenAccess = captureError.domain == SCStreamErrorDomain && captureError.code == SCStreamError.Code.userDeclined.rawValue
                selectionError = needsScreenAccess ? "Allow Reel to record your screen to choose a window." : "That window is unavailable. Choose another window."
            }
        }
    }

    private func selectArea() {
        selectionError = nil
        selectionTask = Task {
            guard !Task.isCancelled else { return }
            setDesktopSelection(.area)
            defer { if !Task.isCancelled { setDesktopSelection(nil); selectionTask = nil } }
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
        .frame(height: desktop ? 110 : 186)
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

    private func restartMeter() {
        micLevel.stop()
        guard !model.meetingMode, s.audio.usesMic, micAccess == .authorized, devices != nil,
              let mic = CaptureDevices.defaultMicrophone(savedID: s.microphoneID) else { return }
        micLevel.start(device: mic)
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
        if on && micAccess == .notDetermined {
            Task {
                _ = await Permissions.request(.audio)
                micAccess = Permissions.status(.audio)
            }
        }
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
