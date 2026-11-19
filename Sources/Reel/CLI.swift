import AppKit
import AVFoundation
import ReelCore
import ScreenCaptureKit

/// Command-line entry points used for verification and automation (see README / VERIFICATION.md):
///   Reel --version | --permissions | --list-devices
///   Reel --transcribe <video.mp4> [--language <locale>] [--cloud-meeting]
///        (cloud mode sends audio to OpenAI and returns transcript plus AI notes; requires sign-in)
///   Reel --record-test <seconds> [--meeting] [--mode screen|window|area|camera] [--area x,y,w,h]
///        [--window-app <name> | --window-id <id>] [--countdown <seconds>]
///        [--audio micOnly|systemOnly|micAndSystem|none] [--no-camera] [--no-upload] [--no-live]
///        [--pause-at <s> --pause-for <s>] [--draw] [--clicks] [--background none|blur|image]
///        [--takes <count> --no-upload]              (starts each take as soon as the recorder is ready)
///        [--crash-after <s>]                          (SIGKILLs itself mid-recording, for recovery tests)
///   Reel --recover                                     (runs launch-time crash recovery, prints JSON)
///   Reel --upload <folder> | --delete <folder> | --rename <folder> <title> | --info <folder>
///   Reel --trim <folder> <start> <end>                 (end 0 = remove trim)
///   Reel --protect <folder> <password> | --unprotect <folder>
///   Reel --expire <folder> <seconds from now | never>
///   Reel --summarize <folder>                          (AI title/summary/chapters from the transcript)
///   Reel --deliver-meeting <folder>                    (retry Notion and internal recap delivery)
/// Uploading from the CLI uses the signed-in session, or REEL_TEST_EMAIL / REEL_TEST_PASSWORD
/// (email/password Firebase account, used only for automated verification; never persisted).
@MainActor
enum CLI {
    struct RecordTest {
        var seconds: Double
        var takes = 1
        var mode: CaptureMode = .screen
        var audio: AudioSource = .micOnly
        var camera = true
        var upload = true
        var live = true
        var mp4 = true
        var displayID: UInt32?
        var pauseAt: Double?
        var pauseFor: Double = 1
        var windowApp: String?
        var windowID: CGWindowID?
        var countdown = 0
        var area: CGRect?
        var draw = false
        var clicks = false
        var background: CameraBackground = .none
        var crashAfter: Double?
        var meeting = false
    }

    nonisolated static func handleImmediate(_ args: [String]) -> Int32? {
        func value(_ flag: String) -> String? { args.firstIndex(of: flag).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
        func values(_ flag: String, _ n: Int) -> [String]? {
            guard let i = args.firstIndex(of: flag), i + n < args.count else { return nil }
            return Array(args[(i + 1)...(i + n)])
        }
        if args.contains("--help") {
            print("Reel — see README.md. Flags: --version --permissions --list-devices --transcribe <file> [--language <locale>] --record-test <s> [--meeting] --recover --upload/--delete/--info <folder> --rename <folder> <title> --trim <folder> <s> <e> --protect <folder> <pw> --unprotect <folder> --expire <folder> <s|never> --summarize <folder>")
            return 0
        }
        if args.contains("--version") {
            print(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")
            return 0
        }
        if args.contains("--permissions") {
            printJSON(MainActor.assumeIsolated { Permissions.summary })
            return 0
        }
        if args.contains("--list-devices") {
            let cams = CaptureDevices.cameras().map(CaptureDevices.info)
            let mics = CaptureDevices.microphones().map(CaptureDevices.info)
            printJSON([
                "cameras": cams.map { ["id": $0.id, "name": $0.name, "kind": $0.kind.rawValue] },
                "microphones": mics.map { ["id": $0.id, "name": $0.name, "kind": $0.kind.rawValue] },
                "defaultCamera": CaptureDevices.defaultCamera(savedID: nil)?.localizedName ?? NSNull(),
                "defaultMicrophone": CaptureDevices.defaultMicrophone(savedID: nil)?.localizedName ?? NSNull(),
                "displays": NSScreen.screens.map { ["name": $0.localizedName, "frame": NSStringFromRect($0.frame), "id": RecorderControllerDisplay.id($0) ?? 0] },
            ] as [String: Any])
            return 0
        }
        if let v = values("--shortcut-check", 3), let action = ShortcutAction(rawValue: v[0]), let key = UInt32(v[1]), let mods = UInt32(v[2]) {
            // Same checks as Settings ▸ General: Reel duplicates, macOS shortcuts, common app
            // shortcuts, and whether another app already registered it (RegisterEventHotKey).
            return MainActor.assumeIsolated {
                let s = Shortcut(keyCode: key, modifiers: mods, key: KeyNames.name(for: key)?.lowercased() ?? "?")
                let settings = AppModel.shared.settings
                let system = HotKeys.systemHotKeys()
                var conflicts = ShortcutConflicts.find(s, for: action, assigned: settings.shortcuts, system: system).map { ["message": $0.message, "blocking": $0.isBlocking] as [String: Any] }
                if let taken = HotKeys.shared.probe(s) { conflicts.append(["message": taken, "blocking": false]) }
                printJSON(["shortcut": s.display, "valid": s.isValid, "action": action.rawValue, "systemShortcutsKnown": system.count, "conflicts": conflicts])
                return 0
            }
        }
        if let file = value("--transcribe") {
            let language = value("--language") ?? {
                let settingsURL = SettingsStore.directory.appendingPathComponent("settings.json")
                guard let data = try? Data(contentsOf: settingsURL),
                      let settings = try? JSONDecoder().decode(ReelSettings.self, from: data) else { return "en-US" }
                return settings.transcriptionLocaleIdentifier
            }()
            return runAsync {
                do {
                    let cloudMeeting = args.contains("--cloud-meeting")
                    let meeting: MeetingDetails?
                    let out: TranscriptionService.Output
                    if cloudMeeting {
                        let session = try await CloudAuth.shared.validSession()
                        let details = MeetingDetails(ownerUserID: session.userID)
                        meeting = details
                        out = try await CloudMeetingSpeech.transcribe(video: URL(fileURLWithPath: file), meeting: details,
                            title: URL(fileURLWithPath: file).lastPathComponent, localeIdentifier: language)
                    } else {
                        meeting = nil
                        out = try await TranscriptionService.transcribe(video: URL(fileURLWithPath: file), localeIdentifier: language)
                    }
                    let segs = TranscriptSegmenter.segments(from: out.pieces)
                    var t = Transcript(id: nil, title: URL(fileURLWithPath: file).lastPathComponent, language: out.locale, engine: out.engine,
                                       createdAt: Date(), durationSeconds: await PostProcessor.duration(of: URL(fileURLWithPath: file)), segments: segs)
                    if let meeting {
                        t.timingGranularity = "chunk"
                        let transcriptJSON = try JSONSerialization.jsonObject(with: t.encoded())
                        do {
                            let notes = try await CloudMeetingSpeech.summarize(transcript: t, meeting: meeting, title: t.title)
                            printJSON(["transcript": transcriptJSON, "summary": notes.summary ?? "", "summaryEngine": notes.engine])
                        } catch {
                            printJSON(["transcript": transcriptJSON, "summaryError": error.localizedDescription])
                            return 1
                        }
                    } else {
                        print(String(data: try t.encoded(), encoding: .utf8)!)
                    }
                    return 0
                } catch {
                    FileHandle.standardError.write(Data("transcribe failed: \(error.localizedDescription)\n".utf8))
                    return 1
                }
            }
        }
        if args.contains("--recover") {
            return runAsync { @MainActor in
                prepareHeadless()
                guard await signInFromEnvironment() else { return 2 }
                let outcome = await Recovery.run()
                // Wait for the follow-up transcript/upload work the recovery started.
                for id in outcome.recovered {
                    while let r = AppModel.shared.recording(id: id), r.transcriptStatus == .pending || r.upload == .uploading || r.upload == .pending {
                        try? await Task.sleep(for: .milliseconds(300))
                        if r.upload == .pending && AppModel.shared.uploadProgress[id] == nil && r.transcriptStatus != .pending { break }
                    }
                }
                let recs = outcome.recovered.compactMap { AppModel.shared.recording(id: $0) }
                printJSON(["recovered": recs.map(describe), "discarded": outcome.discarded, "failed": outcome.failed])
                return outcome.failed.isEmpty ? 0 : 1
            }
        }
        if let v = values("--rename", 2) {
            return withRecording(v[0]) { r in
                await Publisher.shared.rename(r, to: v[1]).value
                let after = AppModel.shared.recording(id: r.id) ?? r
                printJSON(["title": after.title, "shareURL": after.hasPublishableShareID ? (after.shareURL().absoluteString as Any) : NSNull()])
                return 0
            }
        }
        if let v = values("--trim", 3), let s = Double(v[1]), let e = Double(v[2]) {
            return withRecording(v[0]) { r in
                Publisher.shared.setTrim(r, start: s, end: e <= 0 ? r.durationSeconds : e)
                try? await Task.sleep(for: .milliseconds(100))
                await Publisher.shared.publish(AppModel.shared.recording(id: r.id) ?? r, copyLink: false).value
                let after = AppModel.shared.recording(id: r.id) ?? r
                printJSON(describe(after))
                return after.upload == .uploaded || !r.upload.mayHaveRemote ? 0 : 1
            }
        }
        if let v = values("--protect", 2) {
            return withRecording(v[0]) { r in await access(r, .set(v[1]), expiry: r.access.expiresAt) }
        }
        if let folder = value("--unprotect") {
            return withRecording(folder) { r in await access(r, .remove, expiry: r.access.expiresAt) }
        }
        if let v = values("--expire", 2) {
            let date: Date? = v[1] == "never" ? nil : Double(v[1]).map { Date().addingTimeInterval($0) }
            return withRecording(v[0]) { r in await access(r, .keep, expiry: date) }
        }
        if let folder = value("--summarize") {
            return withRecording(folder, signIn: false) { r in
                guard let data = try? Data(contentsOf: AppModel.shared.library.transcriptJSONURL(for: r)),
                      let t = try? ReelJSON.decoder.decode(Transcript.self, from: data) else {
                    FileHandle.standardError.write(Data("no transcript\n".utf8))
                    return 1
                }
                let ai = await SummaryService.summarize(transcript: t, duration: r.durationSeconds)
                printJSON(["engine": ai.engine, "title": ai.title as Any? ?? NSNull(), "summary": ai.summary as Any? ?? NSNull(),
                           "chapters": ai.chapters.map { ["start": $0.start, "title": $0.title] }])
                return 0
            }
        }
        if let folder = value("--info") {
            return withRecording(folder) { r in
                await Publisher.shared.refreshViews(r)
                printJSON(describe(AppModel.shared.recording(id: r.id) ?? r))
                return 0
            }
        }
        if let folder = value("--deliver-meeting") {
            return withRecording(folder) { r in
                do { AppModel.shared.account = try await CloudAuth.shared.validSession() }
                catch {
                    FileHandle.standardError.write(Data("Sign in to Reel before delivering meeting notes.\n".utf8))
                    return 2
                }
                guard r.isMeeting, let owner = r.meeting?.ownerUserID,
                      AppModel.shared.account?.userID == owner else {
                    FileHandle.standardError.write(Data("Sign in as this meeting's owner before delivering it.\n".utf8))
                    return 1
                }
                await Publisher.shared.deliverMeeting(r).value
                guard let after = AppModel.shared.recording(id: r.id) else { return 1 }
                printJSON(describe(after))
                return after.meeting?.deliveryStatus == .confirmed ? 0 : 1
            }
        }
        if let folder = value("--upload") ?? value("--delete") {
            let deleting = args.contains("--delete")
            return withRecording(folder) { r in
                if deleting {
                    await Publisher.shared.delete(r)
                    let gone = !FileManager.default.fileExists(atPath: AppModel.shared.library.folder(for: r).path)
                    printJSON(["deleted": gone, "shareID": r.shareID])
                    return gone ? 0 : 1
                }
                await Publisher.shared.publish(r, copyLink: false).value
                let after = AppModel.shared.recording(id: r.id) ?? r
                printJSON(["upload": after.upload.label, "shareURL": after.hasPublishableShareID ? (after.shareURL().absoluteString as Any) : NSNull()])
                return after.upload == .uploaded ? 0 : 1
            }
        }
        return nil
    }

    private static func access(_ r: Recording, _ change: Publisher.PasswordChange, expiry: Date?) async -> Int32 {
        do {
            try await Publisher.shared.updateAccess(r, password: change, expiresAt: expiry)
            printJSON(describe(AppModel.shared.recording(id: r.id) ?? r))
            return 0
        } catch {
            FileHandle.standardError.write(Data("access change failed: \(error.localizedDescription)\n".utf8))
            return 1
        }
    }

    nonisolated private static func withRecording(_ folder: String, signIn: Bool = true, _ body: @escaping @MainActor (Recording) async -> Int32) -> Int32 {
        runAsync { @MainActor in
            prepareHeadless()
            if signIn { guard await signInFromEnvironment() else { return 2 } }
            AppModel.shared.reloadLibrary()
            let name = URL(fileURLWithPath: folder).standardizedFileURL.lastPathComponent
            guard let r = AppModel.shared.recordings.first(where: { $0.folderName == name || $0.shareID == folder }) else {
                FileHandle.standardError.write(Data("No recording found for \(folder) in \(AppModel.shared.library.root.path)\n".utf8))
                return 1
            }
            return await body(r)
        }
    }

    static func describe(_ r: Recording) -> [String: Any] {
        let lib = AppModel.shared.library
        var out: [String: Any] = [
            "id": r.id, "shareID": r.shareID, "title": r.title, "folder": lib.folder(for: r).path, "video": lib.videoURL(for: r).path,
            "durationSeconds": r.durationSeconds, "size": "\(r.width)x\(r.height)", "mode": r.mode.rawValue,
            "upload": r.upload.label, "captureState": r.captureState.rawValue,
            "playback": ["hls": r.playback.hls, "mp4": r.playback.mp4], "transcriptStatus": r.transcriptStatus.rawValue,
            "protected": r.access.isProtected,
        ]
        if r.hasPublishableShareID {
            out["shareURL"] = r.shareURL().absoluteString
            out["room"] = r.room
            out["location"] = r.location.prefix(shareID: r.shareID)
            out["metaURL"] = ShareLinks.downloadURL(shareID: r.shareID, file: .meta, location: r.location).absoluteString
            out["stubURL"] = ShareLinks.downloadURL(shareID: r.shareID, file: .meta).absoluteString
            out["playlistURL"] = ShareLinks.downloadURL(shareID: r.shareID, file: .playlist, location: r.location).absoluteString
            out["videoURL"] = ShareLinks.downloadURL(shareID: r.shareID, file: .video, location: r.location).absoluteString
            out["transcriptURL"] = ShareLinks.downloadURL(shareID: r.shareID, file: .transcriptJSON, location: r.location).absoluteString
        }
        if let e = r.access.expiresAt { out["expiresAt"] = ISO8601DateFormatter().string(from: e) }
        if let t = r.trim { out["trim"] = ["start": t.start, "end": t.end]; out["trimmedUploaded"] = r.trimmedUploaded }
        if let s = r.summary { out["summary"] = s }
        if let c = r.chapters { out["chapters"] = c.map { ["start": $0.start, "title": $0.title] } }
        if let e = r.summaryEngine { out["summaryEngine"] = e }
        if let meeting = r.meeting, let data = try? JSONEncoder().encode(meeting),
           let value = try? JSONSerialization.jsonObject(with: data) { out["meeting"] = value }
        if let v = r.viewCount { out["views"] = v }
        if let log = SegmentUploader.combinedLog(directory: Publisher.shared.segmentsDirectory(r)) {
            out["segments"] = log.segments.count
            out["segmentsUploaded"] = log.uploaded.count
        }
        if let data = try? Data(contentsOf: lib.transcriptJSONURL(for: r)), let t = try? ReelJSON.decoder.decode(Transcript.self, from: data) {
            out["transcriptEngine"] = t.engine
            out["transcriptText"] = t.text
        }
        return out
    }

    nonisolated static func parseRecordTest(_ args: [String]) -> RecordTest? {
        guard let i = args.firstIndex(of: "--record-test"), i + 1 < args.count, let s = Double(args[i + 1]) else { return nil }
        func value(_ flag: String) -> String? { args.firstIndex(of: flag).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
        var t = RecordTest(seconds: s)
        if let m = value("--mode").flatMap(CaptureMode.init(rawValue:)) { t.mode = m }
        if let a = value("--audio").flatMap(AudioSource.init(rawValue:)) { t.audio = a }
        t.camera = !args.contains("--no-camera")
        t.upload = !args.contains("--no-upload")
        if let count = value("--takes") {
            guard let takes = Int(count), (1...40).contains(takes), takes == 1 || !t.upload else { return nil }
            t.takes = takes
        }
        t.live = !args.contains("--no-live")
        t.mp4 = !args.contains("--no-mp4")
        t.displayID = value("--display").flatMap { UInt32($0) }
        t.pauseAt = value("--pause-at").flatMap(Double.init)
        if let p = value("--pause-for").flatMap(Double.init) { t.pauseFor = p }
        t.windowApp = value("--window-app")
        if args.contains("--window-id") {
            guard t.mode == .window, t.windowApp == nil,
                  let id = value("--window-id").flatMap(CGWindowID.init), id != kCGNullWindowID else { return nil }
            t.windowID = id
        }
        if args.contains("--countdown") {
            guard let seconds = value("--countdown").flatMap(Int.init), (0...10).contains(seconds) else { return nil }
            t.countdown = seconds
        }
        if let a = value("--area")?.split(separator: ",").compactMap({ Double($0) }), a.count == 4 {
            t.area = CGRect(x: a[0], y: a[1], width: a[2], height: a[3])
        }
        t.draw = args.contains("--draw")
        t.clicks = args.contains("--clicks")
        if let b = value("--background").flatMap(CameraBackground.init(rawValue:)) { t.background = b }
        t.crashAfter = value("--crash-after").flatMap(Double.init)
        t.meeting = args.contains("--meeting")
        return t
    }

    static func prepareHeadless() {
        AppModel.shared.persistSettings = false
        RecorderController.shared.headless = true
        Notifier.enabled = false
        Sound.enabled = false
        Toast.enabled = false
    }

    static func signInFromEnvironment() async -> Bool {
        let env = ProcessInfo.processInfo.environment
        if let email = env["REEL_TEST_EMAIL"], let password = env["REEL_TEST_PASSWORD"] {
            do {
                AppModel.shared.account = try await CloudAuth.shared.signInWithPassword(email: email, password: password)
            } catch {
                FileHandle.standardError.write(Data("test sign-in failed: \(error.localizedDescription)\n".utf8))
                return false
            }
        }
        return true
    }

    static func runRecordTest(_ test: RecordTest) {
        prepareHeadless()
        let model = AppModel.shared
        model.meetingMode = test.meeting
        if test.meeting {
            model.meetingTitle = "Meeting verification"
            model.meetingAttendees = ""
        }
        model.settings.mode = test.mode
        model.settings.audio = test.audio
        model.settings.cameraEnabled = test.camera
        model.settings.autoUpload = test.upload
        model.settings.liveUpload = test.live
        model.settings.uploadMP4 = test.mp4
        model.settings.displayID = test.displayID
        model.settings.copyLinkOnStop = test.upload
        model.settings.highlightClicks = test.clicks || model.settings.highlightClicks
        model.settings.cameraBackground = test.background
        model.settings.countdownSeconds = test.countdown
        let rc = RecorderController.shared
        rc.skipCountdown = test.countdown == 0
        rc.presetArea = test.area
        let started = Date()
        var checks: [String: Any] = [:]
        var reports: [[String: Any]] = []
        rc.onRecordingStarted = { session in
            checks["captureRect"] = NSStringFromRect(session.captureRect)
            checks["outputSize"] = "\(session.outputSize.width)x\(session.outputSize.height)"
            if let b = rc.bubble, b.isVisible { checks["bubbleFrame"] = NSStringFromRect(b.frame) }
            if let crash = test.crashAfter {
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(crash))
                    print("[reel] simulating a crash (SIGKILL) after \(crash)s of recording")
                    fflush(stdout)
                    kill(getpid(), SIGKILL)
                }
            }
            if test.draw { Task { @MainActor in await scriptDrawing(session, checks: { checks[$0] = $1 }) } }
            if test.clicks {
                Task { @MainActor in
                    let r = session.captureRect
                    for i in 0..<Int(max(1, test.seconds - 1)) {
                        let p = CGPoint(x: r.minX + r.width * (0.3 + 0.1 * Double(i % 4)), y: r.midY)
                        session.overlays.addClick(ClickEvent(x: p.x, y: p.y, time: RecordingSession.now()))
                        try? await Task.sleep(for: .seconds(1))
                    }
                }
            }
        }
        rc.onFinished = { r in
            var out: [String: Any] = ["ok": r != nil, "isMeeting": test.meeting, "permissions": Permissions.summary]
            if let r {
                out.merge(describe(r)) { a, _ in a }
                if let t = Publisher.shared.stopToPlayable[r.id] { out["stopToPlayableSeconds"] = t }
                if let t = rc.stopToSaved[r.id] { out["stopToSavedSeconds"] = t }
                if let t = rc.stopToReady[r.id] { out["stopToReadySeconds"] = t }
                if test.takes == 1, let s = rc.lastStopAt { out["stoppedAtEpoch"] = s.timeIntervalSince1970 }
                if test.background != .none { out["cameraEffectFrames"] = rc.camera.effects.processed }
            } else {
                out["error"] = model.lastError ?? "recording did not complete"
            }
            out["checks"] = checks
            out["wallSeconds"] = Date().timeIntervalSince(started)
            if test.takes > 1, r != nil {
                reports.append(out)
                if reports.count < test.takes { return }
                out = ["ok": true, "takes": reports]
            }
            printJSON(out)
            exit(r == nil ? 1 : 0)
        }
        Task { @MainActor in
            guard await signInFromEnvironment() else { exit(2) }
            var window: SCWindow?
            if let id = test.windowID {
                let content = try? await ScreenCapture.shareableContent()
                window = content.map(WindowPicker.candidates)?.first { $0.id == id }?.window
                if window == nil { print("no selectable window with ID \(id)"); exit(1) }
            } else if test.mode == .window, let name = test.windowApp {
                let content = try? await ScreenCapture.shareableContent()
                window = content.map(WindowPicker.candidates)?.first { $0.app.localizedCaseInsensitiveContains(name) }?.window
                if window == nil { print("no window for app \(name)"); exit(1) }
            }
            for take in 1...test.takes {
                guard rc.start(window: window, focusWindowOnStart: test.takes == 1) else { exit(1) }
                // Wait for the actual recording. onFinished reports startup failures.
                var countdownObserved = false
                for _ in 0..<300 where model.phase != .recording {
                    if model.phase == .idle { return }
                    if case .countdown = model.phase { countdownObserved = true }
                    try? await Task.sleep(for: .milliseconds(50))
                }
                guard model.phase == .recording else { exit(1) }
                if let at = test.pauseAt {
                    try? await Task.sleep(for: .seconds(at))
                    rc.pauseResume()
                    try? await Task.sleep(for: .seconds(test.pauseFor))
                    rc.pauseResume()
                    try? await Task.sleep(for: .seconds(max(0, test.seconds - at)))
                } else {
                    try? await Task.sleep(for: .seconds(test.seconds))
                }
                if let window, let owner = window.owningApplication, test.windowID != nil {
                    checks["countdownObserved"] = countdownObserved
                    checks["selectedWindowOwnerFrontmost"] = NSWorkspace.shared.frontmostApplication?.processIdentifier == owner.processID
                    checks["recordingWindowLabel"] = model.recordingWindowLabel as Any? ?? NSNull()
                    checks["recordingControlsVisible"] = NSApp.windows.contains { $0 is ControlBarWindow && $0.isVisible }
                    checks["windowFocusResult"] = model.recordingWindowFocus.map { String(describing: $0) } as Any? ?? NSNull()
                }
                rc.stop()
                if take < test.takes {
                    for _ in 0..<1200 where model.phase != .idle {
                        try? await Task.sleep(for: .milliseconds(25))
                    }
                    guard model.phase == .idle else { exit(1) }
                }
            }
        }
    }

    /// Scripted annotations: turns drawing on (checks the overlay now takes the mouse), draws a
    /// red pen zig-zag, a yellow highlighter bar and a blue arrow in the captured area, then turns
    /// drawing off (checks clicks pass through again). The strokes stay visible until stop.
    private static func scriptDrawing(_ session: RecordingSession, checks: (String, Any) -> Void) async {
        let rc = RecorderController.shared
        checks("overlayIgnoresMouseBefore", rc.drawingOverlayIgnoresMouse ?? NSNull())
        rc.toggleDrawing()
        checks("overlayIgnoresMouseWhileDrawing", rc.drawingOverlayIgnoresMouse ?? NSNull())
        let r = session.captureRect
        func p(_ fx: Double, _ fy: Double) -> Point { Point(x: r.minX + r.width * fx, y: r.minY + r.height * fy) }
        rc.setDrawColor(.red)
        rc.setDrawTool(.pen)
        rc.updateDrawing { d in
            d.begin(at: p(0.1, 0.5))
            for i in 1...20 { d.extend(to: p(0.1 + 0.02 * Double(i), 0.5 + (i % 2 == 0 ? 0.05 : -0.05))) }
            d.end()
        }
        try? await Task.sleep(for: .milliseconds(500))
        rc.setDrawTool(.highlighter)
        rc.setDrawColor(.yellow)
        rc.updateDrawing { d in d.begin(at: p(0.55, 0.7)); d.extend(to: p(0.9, 0.7)); d.end() }
        try? await Task.sleep(for: .milliseconds(500))
        rc.setDrawTool(.arrow)
        rc.setDrawColor(.blue)
        rc.updateDrawing { d in d.begin(at: p(0.6, 0.2)); d.extend(to: p(0.85, 0.4)); d.end() }
        try? await Task.sleep(for: .milliseconds(500))
        rc.toggleDrawing()
        checks("overlayIgnoresMouseAfter", rc.drawingOverlayIgnoresMouse ?? NSNull())
        checks("strokes", session.overlays.drawingState.strokes.count)
        checks("penStrokeOutputPoint", "red zig-zag at 10–50% x, 50% y of the capture")
    }

    nonisolated static func printJSON(_ object: Any) {
        if let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) {
            print(String(data: data, encoding: .utf8)!)
        }
    }

    nonisolated static func runAsync(_ body: @escaping @MainActor () async -> Int32) -> Int32 {
        var code: Int32 = 0
        var done = false
        Task { @MainActor in
            code = await body()
            done = true
        }
        while !done { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
        return code
    }
}

/// Display ID helper usable outside the main actor.
enum RecorderControllerDisplay {
    static func id(_ s: NSScreen) -> UInt32? { (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value }
}
