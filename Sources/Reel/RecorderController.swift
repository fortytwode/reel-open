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
    private var liveUpload: Task<SegmentUploader?, Never>?
    private var pending: Recording?
    private var localSaveTail: Task<Void, Never>?
    var currentRecordingID: String? { pending?.id }

    /// Points the active window recording at a replacement meeting window.
    func retargetMeeting(window: SCWindow) async -> Bool {
        guard let session, model.phase == .recording || model.phase == .paused else { return false }
        return await session.retarget(window: window)
    }
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
    private(set) var stopToReady: [String: Double] = [:]
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
    func start(window preselected: SCWindow? = nil, area preselectedArea: CGRect? = nil,
               focusWindowOnStart: Bool = true, authorization: (() -> Bool)? = nil,
               authorizeStart: (() async -> Bool)? = nil, captureSetupFinished: ((Bool) -> Void)? = nil) -> Bool {
        guard model.phase == .idle, !startFlowActive else {
            model.meetingCalendarOccurrenceID = nil
            model.meetingCalendarReference = nil
            return false
        }
        startFlowActive = true
        let requestedArea = preselectedArea ?? presetArea
        model.phase = .preparing
        Task {
            defer { self.startFlowActive = false }
            await self.startFlow(preselected: preselected, requestedArea: requestedArea,
                                 focusWindowOnStart: focusWindowOnStart, authorization: authorization,
                                 authorizeStart: authorizeStart, captureSetupFinished: captureSetupFinished)
        }
        return true
    }

    private func startFlow(preselected: SCWindow?, requestedArea: CGRect?,
                           focusWindowOnStart: Bool, authorization: (() -> Bool)?,
                           authorizeStart: (() async -> Bool)?, captureSetupFinished: ((Bool) -> Void)?) async {
        var captureStarted = false
        defer { captureSetupFinished?(captureStarted) }
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
        if s.audio.usesMic, !(await Permissions.request(.audio)) {
            alertPermission("Microphone", pane: "Privacy_Microphone")
            return bail(nil)
        }
        let mic = s.audio.usesMic ? CaptureDevices.defaultMicrophone(savedID: s.microphoneID) : nil
        if s.audio.usesMic && mic == nil {
            return bail("No microphone is available. Connect a microphone or turn it off before recording.")
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
                if let requestedArea {
                    guard let sourceScreen = NSScreen.screens.first(where: { $0.frame.intersects(requestedArea) }) else {
                        return bail("The selected area is no longer available. Choose an area again.")
                    }
                    screen = sourceScreen
                    area = requestedArea
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
        session.onFatalError = { [weak self, weak session] error in
            Task { @MainActor in
                guard let self, let session, self.session === session,
                      self.model.phase == .recording || self.model.phase == .paused else { return }
                Toast.show("Recording stopped: \(error.localizedDescription)", isError: true)
                self.stop()
            }
        }
        self.session = session
        session.updateBubbleFrame(isBubbleVisible && s.mode != .camera ? bubble?.frame : nil)

        // Reel must own its recording windows before the capture filter is built, so that
        // ScreenCaptureKit lists the app and excludes all of them.
        controlBar = ControlBarWindow(showsWindow: s.mode == .window)
        if s.mode != .camera { drawingOverlay = DrawingOverlay(screen: screen, store: overlays) }
        // Countdown while the local capture devices warm up.
        let seconds = skipCountdown ? 0 : s.countdownSeconds
        let prepare = Task { try await session.prepare() }
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
        do {
            try await prepare.value
            if let selected = window { window = try await ScreenCapture.refreshedWindow(selected) }
        } catch {
            await abandonPreparation(session, recording: recording)
            return bail("Couldn't start recording: \(error.localizedDescription)")
        }
        if model.phase != .idle, authorization?() != false, let authorizeStart, !(await authorizeStart()) {
            await abandonPreparation(session, recording: recording)
            return bail(nil)
        }
        guard model.phase != .idle, authorization?() != false else {   // cancelled
            await abandonPreparation(session, recording: recording)
            return bail(authorization?() == false ? "Meeting setup cancelled because authorization changed." : nil)
        }
        recording = model.recording(id: recording.id) ?? recording
        recording.width = session.outputSize.width
        recording.height = session.outputSize.height
        recording.captureState = .recording
        model.update(recording)
        pending = recording
        if recording.allowsAutomaticCloudDelivery && s.autoUpload && s.liveUpload {
            let upload = Publisher.shared.beginLive(recording)
            liveUpload = upload
            session.onSegment = { entry, log in
                Task {
                    if let uploader = await upload.value { await uploader.segmentWritten(entry, log: log) }
                }
            }
        }
        if s.mode == .window, let window {
            let title = window.title?.trimmingCharacters(in: .whitespacesAndNewlines)
            let appName = window.owningApplication?.applicationName
            model.recordingWindowName = title.flatMap { $0.isEmpty ? nil : $0 }
                ?? appName.flatMap { $0.isEmpty ? nil : $0 }
                ?? "selected window"
            if focusWindowOnStart { (NSApp.delegate as? AppDelegate)?.dismissWindowRecordingSetup() }
        }
        session.begin()
        captureStarted = true
        model.phase = .recording
        Sound.play(.start)
        HotKeys.shared.registerRecordingKeys(s)
        if s.highlightClicks && s.mode != .camera { clickMonitor.start(store: overlays) }
        controlBar?.present(on: screen)
        Log.app.info("Recording started: \(s.mode.rawValue, privacy: .public) \(recording.width)x\(recording.height)")
        onRecordingStarted?(session)
        if focusWindowOnStart, s.mode == .window, let window {
            let recordingID = recording.id
            Task { @MainActor in
                let stillRecording = { self.currentRecordingID == recordingID && self.model.phase == .recording }
                let result = await WindowActivation.activate(window, stillRecording: stillRecording)
                guard stillRecording() else { return }
                self.model.recordingWindowFocus = result
            }
        }
    }

    private func abandonPreparation(_ session: RecordingSession, recording: Recording) async {
        teardownUI()
        await session.cancel()
        await camera.stopAndWait()
        self.session = nil
        removeUnpublished(recording)
    }

    func pauseResume() {
        guard let session else { return }
        if model.phase == .recording { session.pause(); model.phase = .paused; Sound.play(.pause) }
        else if model.phase == .paused { session.resume(); model.phase = .recording; Sound.play(.start) }
    }

    var elapsed: Double { session?.elapsed ?? 0 }

    func stop() {
        guard let session, let recording = pending, model.phase == .recording || model.phase == .paused else { return }
        let stoppedAt = Date()
        lastStopAt = stoppedAt
        let slowStop = beginStoppingUI()
        Sound.play(.stop)
        let upload = liveUpload
        liveUpload = nil
        let finished = onFinished
        let copyLink = model.settings.copyLinkOnStop
        let autoUpload = model.settings.autoUpload
        Task {
            let result: RecordingResult
            do {
                result = try await session.stop()
                try model.updateCapture(recording, state: .finalizing, duration: result.log.totalDuration)
            } catch {
                await releaseCapture(slowStop)
                upload?.cancel()
                Task { await Publisher.shared.cancelLiveStart(for: recording.id) }
                noteSaveFailure(recording, error: error)
                if !headless && !recording.isMeeting {
                    (NSApp.delegate as? AppDelegate)?.showFinishedScreenClip(id: recording.id)
                }
                finished?(nil)
                return
            }
            await releaseCapture(slowStop)
            stopToReady[recording.id] = Date().timeIntervalSince(stoppedAt)
            Log.app.info("Recorder ready \(self.stopToReady[recording.id] ?? 0, format: .fixed(precision: 3)) s after stop")
            if !headless && !recording.isMeeting {
                (NSApp.delegate as? AppDelegate)?.showFinishedScreenClip(id: recording.id)
            }
            await finishRecording(recording, result: result, upload: upload, stoppedAt: stoppedAt,
                                  autoUpload: autoUpload, copyLink: copyLink, finished: finished)
        }
    }

    private func finishRecording(_ recording: Recording, result: RecordingResult, upload: Task<SegmentUploader?, Never>?,
                                 stoppedAt: Date, autoUpload: Bool, copyLink: Bool, finished: ((Recording?) -> Void)?) async {
        let finishShare = Task { () -> Bool in
            guard let uploader = await upload?.value, let latest = model.recording(id: recording.id) else {
                Publisher.shared.clearFinishedLiveStart(for: recording.id)
                return false
            }
            if copyLink { copyAutomaticLink(latest, uploading: true, openPage: true) }
            Publisher.shared.finishLive(latest, uploader: uploader, log: result.log, stoppedAt: stoppedAt)
            return true
        }
        let saved: Recording
        do {
            try await finalizeLocal(recording, log: result.log, segments: result.segmentsDirectory)
            stopToSaved[recording.id] = Date().timeIntervalSince(stoppedAt)
            guard let current = model.recording(id: recording.id) else { finished?(nil); return }
            saved = current
        } catch {
            noteSaveFailure(recording, error: error)
            finished?(nil)
            return
        }
        if saved.isMeeting { Task { _ = await MeetingPortalIndex.publish(saved) } }
        let transcription = Publisher.shared.transcribe(saved)
        if saved.allowsAutomaticCloudDelivery && autoUpload {
            let startedLive = await finishShare.value
            await Publisher.shared.publish(saved, copyLink: false).value
            if !startedLive && copyLink, let latest = model.recording(id: saved.id), latest.upload == .uploaded {
                copyAutomaticLink(latest, uploading: false, openPage: false)
            }
        } else {
            Notifier.post(title: "Recording saved", body: saved.title, url: nil)
        }
        await transcription.value
        finished?(model.recording(id: recording.id))
    }

    private func copyAutomaticLink(_ recording: Recording, uploading: Bool, openPage: Bool) {
        // A slow older take should not interrupt the next recording or replace its link.
        guard model.phase == .idle, !model.recordings.contains(where: {
            !$0.isMeeting && $0.discardRequested != true && $0.createdAt > recording.createdAt
        }) else { return }
        Publisher.shared.copyLinkToClipboard(recording, uploading: uploading, openPage: openPage)
    }

    /// Segments → video.mp4, duration, thumbnail; marks the capture complete.
    func finalizeLocal(_ recording: Recording, log: SegmentLog, segments: URL, recovered: Bool = false) async throws {
        let previous = localSaveTail
        let video = model.library.videoURL(for: recording)
        let thumbnail = model.library.thumbnailURL(for: recording)
        let save = Task.detached(priority: .utility) {
            await previous?.value
            try await PostProcessor.assemble(segments: segments, log: log, output: video)
            let duration = await PostProcessor.duration(of: video)
            guard duration.isFinite, duration > 0 else { throw CocoaError(.fileReadCorruptFile) }
            let hasThumbnail = await PostProcessor.makeThumbnail(video: video, to: thumbnail)
            return (duration, hasThumbnail)
        }
        localSaveTail = Task { _ = try? await save.value }
        let (duration, hasThumbnail) = try await save.value
        try model.updateCapture(recording, state: recovered ? .recovered : .complete,
                                duration: duration, hasThumbnail: hasThumbnail)
        model.captureSaveErrors.removeValue(forKey: recording.id)
        Log.app.info("Saved clip (\(duration)s)")
    }

    func cancel(confirm: Bool = true) {
        if case .countdown = model.phase {
            model.phase = .idle   // startFlow notices and cleans up
            countdown?.close()
            hideBubbleIfIdle()
            return
        }
        guard let session, let recording = pending, model.phase == .recording || model.phase == .paused else { return }
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
        stopDiscarding(session, recording: recording, restart: false)
    }

    private func removeUnpublished(_ recording: Recording) {
        do { try model.library.delete(recording, recoverable: false) }
        catch { model.lastError = error.localizedDescription }
        model.reloadLibrary()
    }

    func restart() {
        guard let session, let recording = pending, model.phase == .recording || model.phase == .paused else { return }
        stopDiscarding(session, recording: recording, restart: true)
    }

    private func stopDiscarding(_ session: RecordingSession, recording: Recording, restart: Bool) {
        do { try model.requestDiscard(recording) }
        catch {
            if !headless { Toast.show("Couldn't discard this take: \(error.localizedDescription)", isError: true) }
            model.lastError = error.localizedDescription
            return
        }
        let slowStop = beginStoppingUI(keepBubble: restart)
        let upload = liveUpload
        upload?.cancel()
        liveUpload = nil
        let finished = onFinished
        Task {
            await session.cancel()
            await releaseCapture(slowStop)
            if restart {
                start(window: session.request.window, area: session.request.area)
            } else {
                Toast.show("Recording discarded")
            }
            await Publisher.shared.cancelLiveStart(for: recording.id)
            let latest = model.recording(id: recording.id) ?? recording
            if latest.upload.mayHaveRemote { await Publisher.shared.delete(latest) }
            else { removeUnpublished(latest) }
            if !restart { finished?(nil) }
        }
    }

    private func beginStoppingUI(keepBubble: Bool = false) -> Task<Void, Never> {
        model.phase = .finishing
        teardownUI(keepBubble: keepBubble)
        return Task {
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
            model.captureStopSlow = true
            if !headless { Toast.show("Still stopping capture. If it stays stuck, reopen Reel to recover the clip.") }
        }
    }

    private func releaseCapture(_ slowStop: Task<Void, Never>) async {
        await camera.stopAndWait()
        slowStop.cancel()
        model.captureStopSlow = false
        session = nil
        pending = nil
        model.phase = .idle
    }

    private func noteSaveFailure(_ recording: Recording, error: Error) {
        guard model.recording(id: recording.id) != nil else { return }
        model.captureSaveErrors[recording.id] = error.localizedDescription
        if model.phase == .idle { model.lastError = error.localizedDescription }
        if !headless { Toast.show("Couldn't save this clip: \(error.localizedDescription)", isError: true) }
    }

    private func teardownUI(keepBubble: Bool = false) {
        controlBar?.close()
        controlBar = nil
        model.recordingWindowName = nil
        model.recordingWindowFocus = nil
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
