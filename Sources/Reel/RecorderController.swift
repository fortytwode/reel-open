import AppKit
import AVFoundation
import ReelCore
import ScreenCaptureKit

/// Start → (window pick / area select) → countdown (capture warms up meanwhile) → record (with
/// live segment upload) → pause/resume, drawing → stop/cancel/restart → assemble MP4 →
/// transcript + summary + remaining uploads + link.
@MainActor
final class RecorderController {
    static let shared = RecorderController()
    private var model: AppModel { AppModel.shared }

    let camera = CameraCapture()
    private(set) var bubble: BubbleWindow?
    private var controlBar: ControlBarWindow?
    private var countdown: CountdownWindow?
    private var drawingOverlay: DrawingOverlay?
    private let clickMonitor = ClickMonitor()
    private var session: RecordingSession?
    private var uploader: SegmentUploader?
    private var pending: Recording?
    var currentRecordingID: String? { pending?.id }
    private(set) var overlays = OverlayStore()
    /// Set by the CLI verification path to observe completion.
    var onFinished: ((Recording?) -> Void)?
    /// CLI: called once recording has begun (for scripted drawing/clicks/crash tests).
    var onRecordingStarted: ((RecordingSession) -> Void)?
    var skipCountdown = false
    /// CLI runs: no modal alerts.
    var headless = false
    /// CLI: preselected area (AppKit global) for area mode.
    var presetArea: CGRect?
    /// Seconds from pressing stop to the local MP4 being saved, per recording id.
    private(set) var stopToSaved: [String: Double] = [:]
    private(set) var lastStopAt: Date?

    // MARK: Bubble preview

    var isBubbleVisible: Bool { bubble?.isVisible ?? false }

    func showBubble() {
        guard model.effectiveSettings().cameraEnabled || model.effectiveSettings().mode == .camera else { return }
        Task {
            guard await Permissions.request(.video) else {
                self.alertPermission("Camera", pane: "Privacy_Camera")
                return
            }
            let current = self.model.effectiveSettings()
            guard current.cameraEnabled || current.mode == .camera else { return }
            guard let device = CaptureDevices.defaultCamera(savedID: current.cameraID) else {
                Toast.show("No camera found", isError: true)
                return
            }
            do { try self.camera.start(device: device) } catch {
                Toast.show(error.localizedDescription, isError: true)
                return
            }
            self.applyCameraEffect()
            self.presentBubble(on: self.targetScreen())
        }
    }

    /// Applies Settings ▸ Camera background to the running camera and the bubble.
    func applyCameraEffect() {
        let s = model.effectiveSettings()
        camera.setBackground(s.cameraBackground, imagePath: s.backgroundImagePath)
        if s.cameraBackground == .none {
            camera.onProcessedFrame = nil
            bubble?.showProcessed(nil)
            panelFrameSink?(nil)
        } else {
            camera.onProcessedFrame = { buffer in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        RecorderController.shared.bubble?.showProcessed(buffer)
                        RecorderController.shared.panelFrameSink?(buffer)
                    }
                }
            }
        }
    }

    private func presentBubble(on screen: NSScreen) {
        if bubble == nil {
            bubble = BubbleWindow(session: camera.session)
            bubble?.onMove = { [weak self] frame in self?.session?.updateBubbleFrame(frame) }
        }
        let previewSettings = model.effectiveSettings()
        let diameter = previewSettings.mode == .camera ? 360 : previewSettings.bubbleSize.diameter
        bubble?.present(diameter: diameter, on: screen)
        session?.updateBubbleFrame(bubble?.frame)
    }

    func hideBubble() {
        bubble?.orderOut(nil)
        bubble?.showProcessed(nil)
        session?.updateBubbleFrame(nil)
        if session == nil { camera.stop() }
    }

    func toggleBubble() { isBubbleVisible ? hideBubble() : showBubble() }

    // MARK: Recorder panel preview

    /// Receives effect-processed camera frames for the recorder panel (nil = show the raw preview).
    var panelFrameSink: ((CVPixelBuffer?) -> Void)?

    /// Starts the camera for the recorder panel's preview without showing the bubble.
    /// Returns the running session, or nil (no permission, no camera, camera off).
    func startPanelPreview() async -> AVCaptureSession? {
        let s = model.effectiveSettings()
        guard s.cameraEnabled || s.mode == .camera else { return nil }
        guard await Permissions.request(.video) else { return nil }
        let current = model.effectiveSettings()
        guard current.cameraEnabled || current.mode == .camera else { return nil }
        guard let device = CaptureDevices.defaultCamera(savedID: s.cameraID) else { return nil }
        do { try camera.start(device: device) } catch { return nil }
        applyCameraEffect()
        return camera.session
    }

    /// Stops the panel's camera unless the bubble or a recording still needs it.
    func stopPanelPreview() {
        panelFrameSink = nil
        if session == nil && !isBubbleVisible { camera.stop() }
    }

    /// The chosen display changed (Settings / menu): the bubble follows it.
    func displayChanged() {
        guard session == nil, isBubbleVisible else { return }
        presentBubble(on: targetScreen())
    }

    // MARK: Start / stop

    func toggle() {
        switch model.phase {
        case .idle: start()
        case .recording, .paused: stop()
        case .countdown: cancel(confirm: false)
        default: break
        }
    }

    // Countdown cancellation can show idle while its asynchronous preparation is
    // still cleaning up. Keep that flow exclusive until it relinquishes ownership.
    private var startFlowActive = false

    @discardableResult
    func start(window preselected: SCWindow? = nil, focusWindowOnStart: Bool = true, authorization: (() -> Bool)? = nil) -> Bool {
        guard model.phase == .idle, !startFlowActive else {
            model.meetingCalendarOccurrenceID = nil
            model.meetingCalendarReference = nil
            return false
        }
        startFlowActive = true
        model.phase = .preparing
        Task {
            defer { self.startFlowActive = false }
            await self.startFlow(preselected: preselected, focusWindowOnStart: focusWindowOnStart, authorization: authorization)
        }
        return true
    }

    private func startFlow(preselected: SCWindow?, focusWindowOnStart: Bool, authorization: (() -> Bool)?) async {
        let s = model.effectiveSettings()
        let captureOwnerUserID = await CloudAuth.shared.current?.userID
        func bail(_ message: String?) {
            if let message { Toast.show(message, isError: true); model.lastError = message }
            model.phase = .idle
            onFinished?(nil)
        }
        var meeting: MeetingDetails?
        let requestedTitle = model.meetingTitle
        if model.meetingMode {
            do {
                meeting = try MeetingCapturePolicy.takeMeeting(attendeeText: model.meetingAttendees, ownerUserID: captureOwnerUserID,
                    occurrenceID: &model.meetingCalendarOccurrenceID, calendar: &model.meetingCalendarReference)
            } catch { return bail(error.localizedDescription) }
            if let existing = model.existingMeeting(forOccurrence: meeting?.calendarOccurrenceID) {
                model.phase = .idle
                Toast.show("This calendar meeting is already in your Library.")
                onFinished?(existing)
                return
            }
            hideBubble()
        } else { meeting = nil }
        // Ask the API that actually captures. CoreGraphics preflight can disagree with
        // ScreenCaptureKit (or reflect the launching terminal's grant in CLI runs).
        var content: SCShareableContent?
        if s.mode != .camera {
            do { content = try await ScreenCapture.shareableContent() }
            catch {
                let e = error as NSError
                Log.capture.error("Screen content unavailable: \(e.domain, privacy: .public) \(e.code) \(e.localizedDescription, privacy: .public)")
                if e.domain == SCStreamErrorDomain && e.code == SCStreamError.Code.userDeclined.rawValue {
                    alertPermission("Screen Recording", pane: "Privacy_ScreenCapture",
                                    extra: "If Reel is already on, remove its old entry with the minus button, add Reel from Applications again, then restart Reel.", canRestart: true)
                    return bail(nil)
                }
                return bail("Can't read screen content: \(error.localizedDescription)")
            }
        }
        guard authorization?() != false else { return bail("Meeting setup cancelled because authorization changed.") }
        let wantsCamera = s.mode == .camera || s.cameraEnabled
        if wantsCamera, !(await Permissions.request(.video)) {
            alertPermission("Camera", pane: "Privacy_Camera")
            return bail(nil)
        }
        let mic: AVCaptureDevice? = s.audio.usesMic ? CaptureDevices.defaultMicrophone(savedID: s.microphoneID) : nil
        if s.audio.usesMic, !(await Permissions.request(.audio)) {
            alertPermission("Microphone", pane: "Privacy_Microphone")
            return bail(nil)
        }

        // What to capture.
        var display: SCDisplay?
        var window: SCWindow? = preselected
        var area: CGRect?
        var screen = targetScreen()
        if s.mode != .camera {
            switch s.mode {
            case .window where window == nil:
                guard let content else { return bail("No windows available") }
                window = await WindowPicker.pick(from: content)
                guard window != nil else { return bail(nil) }
            case .area:
                if let preset = presetArea, let sc = NSScreen.screens.first(where: { $0.frame.intersects(preset) }) {
                    screen = sc
                    area = preset
                } else {
                    bubble?.orderOut(nil)
                    guard let pick = await AreaSelector.select(previous: s.lastArea?.cg) else {
                        if wantsCamera, bubble != nil { presentBubble(on: screen) }
                        return bail(nil)
                    }
                    screen = pick.screen
                    area = pick.rect
                    model.settings.lastArea = Rect(pick.rect)
                }
            default: break
            }
            if let selected = window {
                do { window = try await ScreenCapture.refreshedWindow(selected) }
                catch { return bail(error.localizedDescription) }
            }
            if let w = window {
                let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
                let rect = VideoGeometry.appKitRect(fromCG: Rect(w.frame), primaryHeight: primaryHeight).cg
                screen = NSScreen.screens.max { $0.frame.intersection(rect).width * $0.frame.intersection(rect).height < $1.frame.intersection(rect).width * $1.frame.intersection(rect).height } ?? screen
            }
            let id = Self.displayID(of: screen)
            display = content?.displays.first { $0.displayID == id } ?? content?.displays.first
        }

        guard authorization?() != false else { return bail("Meeting setup cancelled because authorization changed.") }

        // Camera (bubble or camera-only source), on the recorded display / inside the area.
        if wantsCamera {
            if let device = CaptureDevices.defaultCamera(savedID: s.cameraID) {
                do { try camera.start(device: device) } catch { return bail(error.localizedDescription) }
                applyCameraEffect()
                presentBubble(on: screen)
                if let area, let b = bubble, !area.contains(b.frame) {
                    b.place(VideoGeometry.bubbleInside(area: Rect(area), diameter: s.bubbleSize.diameter).cg)
                }
            } else if s.mode == .camera {
                return bail("No camera found")
            }
        }

        // Library entry + session. The manifest is written now (captureState .recording) so an
        // interrupted recording is found and rebuilt on the next launch.
        let now = Date()
        let shareID = ShareLinks.newShareID()
        var recording = Recording(shareID: shareID, title: Recording.defaultTitle(for: now), createdAt: now, durationSeconds: 0,
                                  width: 0, height: 0, mode: s.mode, folderName: Recording.folderName(for: now, shareID: shareID),
                                  upload: s.autoUpload ? .pending : .localOnly, recordingNonce: ShareLinks.newRecordingNonce())
        if let captureOwnerUserID { recording.bindToPublisher(captureOwnerUserID) }
        recording.meeting = meeting
        if meeting != nil {
            recording.title = Recording.cleanTitle(requestedTitle) ?? MeetingDetails.defaultTitle(for: now)
            recording.titleIsCustom = Recording.cleanTitle(requestedTitle) != nil
        }
        recording.captureState = .recording
        do {
            try model.insertRecording(recording)
        } catch {
            return bail("Cannot create the recording: \(error.localizedDescription)")
        }
        let folder = model.library.folder(for: recording)
        overlays = OverlayStore()
        model.drawing = DrawingState()
        let request = RecordingRequest(mode: s.mode, display: display, window: window, area: area, content: content,
                                       camera: wantsCamera ? camera : nil, microphone: mic, audio: s.audio,
                                       quality: s.quality, fps: s.fps, showsCursor: s.showCursor, showClicks: s.highlightClicks)
        let session = RecordingSession(request: request, segmentsDirectory: folder.appendingPathComponent(SegmentLog.directoryName, isDirectory: true), overlays: overlays)
        session.onFatalError = { [weak self] error in
            Task { @MainActor in
                Toast.show("Recording stopped: \(error.localizedDescription)", isError: true)
                self?.stop()
            }
        }
        self.session = session
        session.updateBubbleFrame(isBubbleVisible && s.mode != .camera ? bubble?.frame : nil)

        // Reel must own its recording windows before the capture filter is built, so that
        // ScreenCaptureKit lists the app and excludes all of them.
        controlBar = ControlBarWindow()
        if s.mode != .camera { drawingOverlay = DrawingOverlay(screen: screen, store: overlays) }
        // Countdown while capture warms up and the live upload is set up.
        let seconds = skipCountdown ? 0 : s.countdownSeconds
        let prepare = Task { try await session.prepare() }
        let live = Task { await Publisher.shared.beginLive(recording) }
        if seconds > 0 {
            let cd = CountdownWindow()
            countdown = cd
            for n in stride(from: seconds, through: 1, by: -1) {
                model.phase = .countdown(n)
                cd.show(number: n, on: screen)
                try? await Task.sleep(for: .seconds(1))
                if authorization?() == false { model.phase = .idle }
                if model.phase == .idle { break }   // cancelled during countdown
            }
            cd.close()
            countdown = nil
        }
        let liveUploader = await live.value
        let cleanup = { [self] in
            await session.cancel()
            self.session = nil
            self.drawingOverlay?.close()
            self.drawingOverlay = nil
            if liveUploader != nil, let r = self.model.recording(id: recording.id) { await Publisher.shared.delete(r) }
            else {
                do { try self.model.library.delete(recording, recoverable: false) }
                catch { self.model.lastError = error.localizedDescription }
                self.model.reloadLibrary()
            }
        }
        do { try await prepare.value } catch {
            await cleanup()
            return bail("Couldn't start recording: \(error.localizedDescription)")
        }
        guard model.phase != .idle, authorization?() != false else {   // cancelled
            await cleanup()
            return bail(authorization?() == false ? "Meeting setup cancelled because authorization changed." : nil)
        }
        if let liveUploader {
            session.onSegment = { entry, log in Task { await liveUploader.segmentWritten(entry, log: log) } }
        }
        uploader = liveUploader
        recording = model.recording(id: recording.id) ?? recording
        recording.width = session.outputSize.width
        recording.height = session.outputSize.height
        recording.captureState = .recording
        model.update(recording)
        pending = recording
        session.begin()
        model.phase = .recording
        Sound.play(.start)
        HotKeys.shared.registerRecordingKeys(s)
        if s.highlightClicks && s.mode != .camera { clickMonitor.start(store: overlays) }
        controlBar?.present(on: screen)
        Log.app.info("Recording started: \(s.mode.rawValue, privacy: .public) \(recording.width)x\(recording.height) live=\(liveUploader != nil)")
        onRecordingStarted?(session)
        if focusWindowOnStart, s.mode == .window, let window {
            let recordingID = recording.id
            Task { @MainActor in
                let stillRecording = { self.currentRecordingID == recordingID && self.model.phase == .recording }
                let result = await WindowActivation.activate(window, stillRecording: stillRecording)
                guard stillRecording(), !self.headless else { return }
                switch result {
                case .activated, .cancelled: break
                case .accessibilityRequired:
                    Toast.show("Allow Reel in System Settings → Privacy & Security → Accessibility to focus the recorded window.")
                case .unavailable:
                    Toast.show("Couldn't focus the selected window. Recording has started.")
                }
            }
        }
    }

    func pauseResume() {
        guard let session else { return }
        if model.phase == .recording { session.pause(); model.phase = .paused; Sound.play(.pause) }
        else if model.phase == .paused { session.resume(); model.phase = .recording; Sound.play(.start) }
    }

    var elapsed: Double { session?.elapsed ?? 0 }

    func stop() {
        guard let session, var recording = pending, model.phase == .recording || model.phase == .paused else { return }
        let stoppedAt = Date()
        lastStopAt = stoppedAt
        model.phase = .finishing
        teardownUI()
        Sound.play(.stop)
        let uploader = self.uploader
        self.uploader = nil
        Task {
            do {
                let result = try await session.stop()
                self.session = nil
                self.pending = nil
                recording = self.model.recording(id: recording.id) ?? recording
                recording.captureState = .finalizing
                recording.durationSeconds = result.log.totalDuration
                self.model.update(recording)
                // Loom copies the link the moment recording stops; the remaining seconds of video
                // upload while the viewer shows "Finishing upload…".
                if let uploader, recording.allowsAutomaticCloudDelivery {
                    if self.model.settings.copyLinkOnStop { Publisher.shared.copyLinkToClipboard(recording, uploading: true, openPage: true) }
                    Publisher.shared.finishLive(recording, uploader: uploader, log: result.log, stoppedAt: stoppedAt)
                }
                try await self.finalizeLocal(recording, log: result.log, segments: result.segmentsDirectory)
                self.stopToSaved[recording.id] = Date().timeIntervalSince(stoppedAt)
                self.model.phase = .idle
                guard let saved = self.model.recording(id: recording.id) else { return }
                if saved.isMeeting {
                    Task { _ = await MeetingPortalIndex.publish(saved) }
                }
                let transcription = Publisher.shared.transcribe(saved)
                if saved.allowsAutomaticCloudDelivery && self.model.settings.autoUpload {
                    await Publisher.shared.publish(saved, copyLink: uploader == nil && self.model.settings.copyLinkOnStop).value
                } else {
                    Notifier.post(title: "Recording saved", body: saved.title, url: nil)
                }
                await transcription.value
                self.onFinished?(self.model.recording(id: recording.id))
            } catch {
                self.session = nil
                self.pending = nil
                self.model.phase = .idle
                Toast.show("Couldn't save recording: \(error.localizedDescription)", isError: true)
                self.model.lastError = error.localizedDescription
                self.onFinished?(nil)
            }
        }
    }

    /// Segments → video.mp4, duration, thumbnail; marks the capture complete.
    func finalizeLocal(_ recording: Recording, log: SegmentLog, segments: URL, recovered: Bool = false) async throws {
        var r = recording
        let video = model.library.videoURL(for: r)
        try await PostProcessor.assemble(segments: segments, log: log, output: video)
        r.durationSeconds = await PostProcessor.duration(of: video)
        r.hasThumbnail = await PostProcessor.makeThumbnail(video: video, to: model.library.thumbnailURL(for: r))
        r.captureState = recovered ? .recovered : .complete
        model.update(r)
        Log.app.info("Saved \(video.path, privacy: .public) (\(r.durationSeconds)s)")
    }

    func cancel(confirm: Bool = true) {
        if case .countdown = model.phase {
            model.phase = .idle   // startFlow notices and cleans up
            countdown?.close()
            hideBubbleIfIdle()
            return
        }
        guard let session, let recording = pending else { return }
        if confirm && elapsed > 3 && !headless {
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "Discard this recording?"
            alert.informativeText = "The \(Transcript.timestamp(elapsed)) you've recorded will be deleted."
            alert.addButton(withTitle: "Discard")
            alert.addButton(withTitle: "Keep Recording")
            alert.alertStyle = .warning
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        model.phase = .finishing
        teardownUI()
        uploader = nil
        Task {
            await session.cancel()
            self.session = nil
            self.pending = nil
            await self.discard(recording)
            self.model.phase = .idle
            Toast.show("Recording discarded")
            self.onFinished?(nil)
        }
    }

    /// Removes a cancelled recording locally and (if live upload had started) remotely.
    private func discard(_ recording: Recording) async {
        let r = model.recording(id: recording.id) ?? recording
        if r.upload.mayHaveRemote { await Publisher.shared.delete(r) }
        else {
            do { try model.library.delete(r, recoverable: false) }
            catch { model.lastError = error.localizedDescription }
            model.reloadLibrary()
        }
    }

    func restart() {
        guard let session, let recording = pending else { return }
        model.phase = .finishing
        teardownUI(keepBubble: true)
        uploader = nil
        Task {
            await session.cancel()
            self.session = nil
            self.pending = nil
            await self.discard(recording)
            self.model.phase = .idle
            if recording.mode == .area { self.presetArea = self.model.settings.lastArea?.cg }
            self.start(window: recording.mode == .window ? session.request.window : nil)
            self.presetArea = nil
        }
    }

    private func teardownUI(keepBubble: Bool = false) {
        controlBar?.close()
        controlBar = nil
        clickMonitor.stop()
        overlays.updateDrawing { $0.setActive(false) }
        model.drawing = overlays.drawingState
        drawingOverlay?.close()
        drawingOverlay = nil
        HotKeys.shared.unregisterRecordingKeys()
        if !keepBubble { hideBubble() }
    }

    private func hideBubbleIfIdle() { if session == nil { hideBubble() } }

    // MARK: Drawing

    func toggleDrawing() {
        guard session != nil, model.settings.mode != .camera else { return }
        updateDrawing { $0.toggle() }
    }
    func setDrawTool(_ t: DrawTool) { updateDrawing { $0.tool = t; if !$0.isActive { $0.setActive(true) } } }
    func setDrawColor(_ c: DrawColor) { updateDrawing { $0.color = c } }
    func undoDrawing() { updateDrawing { $0.undo() } }
    func clearDrawing() { updateDrawing { $0.clear() } }

    func updateDrawing(_ change: (inout DrawingState) -> Void) {
        overlays.updateDrawing(change)
        model.drawing = overlays.drawingState
        drawingOverlay?.refresh()
        controlBar?.setExpanded(model.drawing.isActive)
    }

    /// For verification: whether the drawing overlay currently lets clicks through.
    var drawingOverlayIgnoresMouse: Bool? { drawingOverlay?.ignoresMouseEvents }

    // MARK: Displays

    /// Display to record: saved choice, else the screen with the mouse pointer (Loom-style).
    func targetScreen() -> NSScreen {
        if let id = model.settings.displayID, let s = NSScreen.screens.first(where: { Self.displayID(of: $0) == id }) {
            return s
        }
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
    }

    static func displayID(of screen: NSScreen) -> UInt32? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }

    private func alertPermission(_ name: String, pane: String, extra: String = "", canRestart: Bool = false) {
        if headless {
            model.lastError = "\(name) permission not granted for Reel (System Settings ▸ Privacy & Security ▸ \(name))"
            return
        }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Reel needs \(name) access"
        alert.informativeText = "Turn on Reel in System Settings ▸ Privacy & Security ▸ \(name). \(extra)"
        alert.addButton(withTitle: "Open System Settings")
        if canRestart { alert.addButton(withTitle: "Restart Reel") }
        alert.addButton(withTitle: "Cancel")
        let response = alert.runModal()
        if response == .alertFirstButtonReturn { Permissions.openSettings(pane) }
        else if canRestart && response == .alertSecondButtonReturn { AppDelegate.relaunch() }
    }
}
