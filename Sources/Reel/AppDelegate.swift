import AppKit
import AVFoundation
import Combine
import ReelCore
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSPopoverDelegate, NSMenuItemValidation, NSWindowDelegate {
    private var statusItem: NSStatusItem!
    private let statusMenu = NSMenu()
    private var popover: NSPopover?
    private var libraryWindow: NSWindow?
    private var workspaceWindow: NSWindow?
    private var settingsWindow: NSWindow?
    private var meetingsWindow: NSWindow?
    private var meetingSetupWindow: NSWindow?
    private var meetingSetupModel: MeetingSetupModel?
    private var timer: Timer?
    private var meetingDeliveryTimer: Timer?
    private var cancellables = Set<AnyCancellable>()
    var cliRecordTest: CLI.RecordTest?

    private var model: AppModel { AppModel.shared }

    func applicationDidFinishLaunching(_ notification: Notification) {
        ReelAppearance.shared.apply()
        // New status items go leftmost, which on a crowded notched menu bar hides them behind
        // the notch. Start near the right edge (points from it); ⌘-drag moves it and macOS saves that.
        let positionKey = "NSStatusItem Preferred Position Item-0"
        if UserDefaults.standard.object(forKey: positionKey) == nil {
            UserDefaults.standard.set(420.0, forKey: positionKey)
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusMenu.delegate = self
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusItemClicked)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        model.$phase.sink { [weak self] phase in
            if phase != .idle {
                DispatchQueue.main.async {
                    self?.popover?.performClose(nil)
                    if phase == .preparing {
                        self?.libraryWindow?.orderOut(nil)
                        self?.settingsWindow?.orderOut(nil)
                    }
                    self?.meetingSetupModel?.cancelPendingActions()
                    self?.meetingSetupWindow?.orderOut(nil)
                }
            }
        }.store(in: &cancellables)
        updateStatusButton()
        model.$phase.sink { [weak self] _ in DispatchQueue.main.async { self?.updateStatusButton() } }.store(in: &cancellables)
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            MainActor.assumeIsolated { [weak self] in self?.updateStatusButton() }
        }
        if let test = cliRecordTest {
            CLI.runRecordTest(test)
            return
        }
        Notifier.shared.setUp()
        MeetingJoinCoordinator.shared.start()
        meetingDeliveryTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
            MainActor.assumeIsolated { Publisher.shared.resumeMeetingProcessing() }
        }
        Updater.shared.start()
        HotKeys.shared.registerMain(model.settings.shortcut)
        installMainMenu()
        Task { _ = await Recovery.run() }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.model.phase == .idle else { return }
            if MeetingSetupIntroduction.shouldPresent(lastPresentedVersion: OrganizationState.defaults.integer(forKey: MeetingSetupIntroduction.defaultsKey)) {
                self.showMeetingSetup()
            } else { self.showMeetingWorkspace() }
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "reel" {
            switch url.host {
            case "record", "toggle": RecorderController.shared.toggle()
            case "stop": RecorderController.shared.stop()
            case "library": openWebLibrary()
            case "local-library": showLibrary()
            case "home": showMeetingWorkspace()
            case "settings": showSettings()
            case "meetings": showMeetings()
            case "meeting-setup": showMeetingSetup()
            case "join-meeting":
                if let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "id" })?.value {
                    Task { await MeetingJoinCoordinator.shared.select(id: id); self.showMeetings() }
                }
            case "meeting-link":
                if let link = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "url" })?.value {
                    MeetingJoinCoordinator.shared.prepareLink(link); showMeetings()
                }
            default: break
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMeetingWorkspace()
        return false
    }

    /// A normal application menu, available whenever Reel is the active app.
    private func installMainMenu() {
        let bar = NSMenu()
        func submenu(_ title: String) -> NSMenu {
            let entry = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let menu = NSMenu(title: title)
            entry.submenu = menu
            bar.addItem(entry)
            return menu
        }
        let reel = submenu("Reel")
        reel.addItem(NSMenuItem(title: "About Reel", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
        reel.addItem(.separator())
        let settings = item("Settings…", #selector(showSettings)); settings.keyEquivalent = ","
        reel.addItem(settings)
        if Updater.shared.isAvailable {
            let update = NSMenuItem(title: "Check for Updates…", action: #selector(Updater.checkForUpdates(_:)), keyEquivalent: "")
            update.target = Updater.shared
            reel.addItem(update)
        }
        reel.addItem(.separator())
        let quit = item("Quit Reel", #selector(quit)); quit.keyEquivalent = "q"; reel.addItem(quit)
        let file = submenu("File")
        file.addItem(item("New Recording", #selector(showRecorder)))
        file.addItem(item("Stop and Share", #selector(stopRecording)))
        file.addItem(item("Pause Recording", #selector(pauseResume)))
        file.addItem(item("Cancel Recording…", #selector(cancelRecording)))
        file.addItem(.separator())
        let meetings = item("Meetings", #selector(showMeetingWorkspace)); meetings.keyEquivalent = "1"; file.addItem(meetings)
        let library = item("Web Library", #selector(openWebLibrary)); library.keyEquivalent = "l"; file.addItem(library)
        file.addItem(item("Screen Recordings…", #selector(showLibrary)))
        file.addItem(item("Meeting Calendars…", #selector(showMeetings)))
        file.addItem(item("Set Up Automatic Meetings…", #selector(showMeetingSetup)))
        let close = NSMenuItem(title: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        file.addItem(close)
        let edit = submenu("Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(NSMenuItem(title: title, action: Selector(action), keyEquivalent: key))
        }
        let window = submenu("Window")
        window.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        window.addItem(NSMenuItem(title: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: ""))
        NSApp.windowsMenu = window
        NSApp.mainMenu = bar
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(showRecorder), #selector(showMeetingSetup): return model.phase == .idle
        case #selector(stopRecording): return model.phase == .recording || model.phase == .paused
        case #selector(pauseResume):
            menuItem.title = model.phase == .paused ? "Resume Recording" : "Pause Recording"
            return model.phase == .recording || model.phase == .paused
        case #selector(cancelRecording):
            if case .countdown = model.phase { return true }
            return model.phase == .recording || model.phase == .paused
        default: return true
        }
    }

    @objc private func showRecorder() { if model.phase == .idle { togglePanel() } }
    @objc private func openWebLibrary() {
        guard CloudConfig.default.isConfigured else { return }
        NSWorkspace.shared.open(CloudConfig.default.notesBaseURL)
    }

    static func relaunch() {
        HotKeys.shared.unregister(.startStop)
        HotKeys.shared.unregisterRecordingKeys()
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { _, error in
            Task { @MainActor in
                if error == nil { NSApp.terminate(nil) }
                else {
                    HotKeys.shared.registerMain(AppModel.shared.settings.shortcut)
                    Toast.show("Couldn't restart Reel: \(error!.localizedDescription)", isError: true)
                }
            }
        }
    }

    // MARK: Status item click: recorder panel when idle, control menu otherwise (and on right-click)

    @objc private func statusItemClicked() {
        let rightClick = NSApp.currentEvent?.type == .rightMouseUp
        if model.phase == .idle && !rightClick {
            togglePanel()
        } else {
            popover?.performClose(nil)
            statusItem.menu = statusMenu
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
        }
    }

    private func togglePanel() {
        if let popover, popover.isShown { popover.performClose(nil); return }
        presentRecorderPanel()
    }

    func showScreenRecordingPanel() {
        guard !model.isBusy else { return }
        model.meetingMode = false
        model.meetingTitle = ""
        model.meetingAttendees = ""
        model.meetingCalendarOccurrenceID = nil
        model.meetingCalendarReference = nil
        presentRecorderPanel()
    }

    private func presentRecorderPanel() {
        guard model.phase == .idle, popover?.isShown != true, let button = statusItem.button else { return }
        let p = NSPopover()
        p.behavior = .transient
        p.delegate = self
        p.contentViewController = NSHostingController(rootView: RecorderPanel(
            model: model,
            start: { [weak self] in self?.popover?.performClose(nil); RecorderController.shared.start() },
            signIn: { [weak self] in self?.popover?.performClose(nil); self?.signIn() },
            copyLastLink: { [weak self] in self?.popover?.performClose(nil); self?.copyLastLink() }))
        popover = p
        NSApp.activate(ignoringOtherApps: true)
        p.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    }

    func popoverDidClose(_ notification: Notification) {
        if model.phase == .idle { RecorderController.shared.stopPanelPreview() }
        popover = nil
    }

    private func updateStatusButton() {
        guard let button = statusItem?.button else { return }
        switch model.phase {
        case .recording, .paused:
            let t = Int(RecorderController.shared.elapsed)
            button.image = NSImage(systemSymbolName: model.phase == .paused ? "pause.circle.fill" : "record.circle.fill", accessibilityDescription: "Recording")
            button.contentTintColor = model.phase == .paused ? .systemOrange : .systemRed
            button.title = String(format: " %d:%02d", t / 60, t % 60)
        case .countdown(let n):
            button.image = NSImage(systemSymbolName: "timer", accessibilityDescription: "Countdown")
            button.contentTintColor = nil
            button.title = " \(n)"
        case .finishing, .preparing:
            button.image = NSImage(systemSymbolName: "record.circle", accessibilityDescription: "Reel")
            button.contentTintColor = .secondaryLabelColor
            button.title = ""
        case .idle:
            let uploading = !model.uploadProgress.isEmpty
            button.image = NSImage(systemSymbolName: uploading ? "icloud.and.arrow.up" : "record.circle", accessibilityDescription: "Reel")
            button.contentTintColor = nil
            button.title = ""
        }
        button.imagePosition = .imageLeading
    }

    // MARK: Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let s = model.settings
        switch model.phase {
        case .recording, .paused:
            menu.addItem(item("Meetings", #selector(showMeetingWorkspace)))
            menu.addItem(item("Stop and Share  (\(s.shortcut.display))", #selector(stopRecording)))
            menu.addItem(item(model.phase == .paused ? "Resume  (\(s.pauseShortcut.display))" : "Pause  (\(s.pauseShortcut.display))", #selector(pauseResume)))
            if s.mode != .camera {
                menu.addItem(item(model.drawing.isActive ? "Stop Drawing  (\(s.drawShortcut.display))" : "Draw on Screen  (\(s.drawShortcut.display))", #selector(toggleDrawing)))
            }
            menu.addItem(item("Restart", #selector(restartRecording)))
            menu.addItem(item("Cancel Recording…", #selector(cancelRecording)))
            return
        case .countdown:
            menu.addItem(item("Cancel Countdown", #selector(cancelRecording)))
            return
        case .preparing, .finishing:
            menu.addItem(NSMenuItem(title: "Finishing…", action: nil, keyEquivalent: ""))
            return
        case .idle:
            break
        }
        menu.addItem(item("Start Recording  (\(s.shortcut.display))", #selector(startRecording)))
        menu.addItem(.separator())
        for mode in CaptureMode.allCases {
            let i = item(mode.label, #selector(selectMode(_:)))
            i.representedObject = mode.rawValue
            i.state = s.mode == mode ? .on : .off
            menu.addItem(i)
        }
        if NSScreen.screens.count > 1 || s.displayID != nil {
            let displayMenu = NSMenu()
            let auto = item("Screen with the Pointer", #selector(selectDisplay(_:)))
            auto.state = s.displayID == nil ? .on : .off
            displayMenu.addItem(auto)
            for screen in NSScreen.screens {
                let i = item(screen.localizedName, #selector(selectDisplay(_:)))
                i.representedObject = RecorderController.displayID(of: screen).map { NSNumber(value: $0) }
                i.state = s.displayID != nil && s.displayID == RecorderController.displayID(of: screen) ? .on : .off
                displayMenu.addItem(i)
            }
            let current = s.displayID.flatMap { id in NSScreen.screens.first { RecorderController.displayID(of: $0) == id }?.localizedName } ?? "Pointer"
            let displayItem = NSMenuItem(title: "Display: \(current)", action: nil, keyEquivalent: "")
            displayItem.submenu = displayMenu
            menu.addItem(displayItem)
        }
        menu.addItem(.separator())

        let cameraMenu = NSMenu()
        let off = item("No Camera", #selector(selectCamera(_:)))
        off.state = s.cameraEnabled ? .off : .on
        cameraMenu.addItem(off)
        let currentCamera = CaptureDevices.defaultCamera(savedID: s.cameraID)?.uniqueID
        for cam in CaptureDevices.cameras() {
            let i = item(cam.localizedName, #selector(selectCamera(_:)))
            i.representedObject = cam.uniqueID
            i.state = s.cameraEnabled && cam.uniqueID == currentCamera ? .on : .off
            cameraMenu.addItem(i)
        }
        let cameraItem = NSMenuItem(title: "Camera: \(s.cameraEnabled ? (CaptureDevices.defaultCamera(savedID: s.cameraID)?.localizedName ?? "none") : "Off")", action: nil, keyEquivalent: "")
        cameraItem.submenu = cameraMenu
        menu.addItem(cameraItem)

        let micMenu = NSMenu()
        let currentMic = CaptureDevices.defaultMicrophone(savedID: s.microphoneID)?.uniqueID
        for mic in CaptureDevices.microphones() {
            let i = item(mic.localizedName, #selector(selectMic(_:)))
            i.representedObject = mic.uniqueID
            i.state = mic.uniqueID == currentMic ? .on : .off
            micMenu.addItem(i)
        }
        micMenu.addItem(.separator())
        for source in AudioSource.allCases {
            let i = item(source.label, #selector(selectAudio(_:)))
            i.representedObject = source.rawValue
            i.state = s.audio == source ? .on : .off
            micMenu.addItem(i)
        }
        let micName = s.audio.usesMic ? (CaptureDevices.defaultMicrophone(savedID: s.microphoneID)?.localizedName ?? "none") : "Off"
        let micItem = NSMenuItem(title: "Microphone: \(micName)\(s.audio.usesSystem ? " + system audio" : "")", action: nil, keyEquivalent: "")
        micItem.submenu = micMenu
        menu.addItem(micItem)
        let preview = item(RecorderController.shared.isBubbleVisible ? "Hide Camera Preview" : "Show Camera Preview", #selector(toggleBubble))
        menu.addItem(preview)

        menu.addItem(.separator())
        if let last = model.recordings.first, last.upload == .uploaded {
            menu.addItem(item("Copy Last Link", #selector(copyLastLink)))
        }
        let lib = item("Web Library", #selector(openWebLibrary))
        lib.keyEquivalent = "l"
        menu.addItem(lib)
        menu.addItem(item("Meetings", #selector(showMeetingWorkspace)))
        menu.addItem(item("Screen Recordings…", #selector(showLibrary)))
        menu.addItem(item("Meeting Calendars…", #selector(showMeetings)))
        menu.addItem(item("Set Up Automatic Meetings…", #selector(showMeetingSetup)))
        let settings = item("Settings…", #selector(showSettings))
        settings.keyEquivalent = ","
        menu.addItem(settings)
        if model.account == nil {
            menu.addItem(item("Sign in with Google to Share…", #selector(signIn)))
        }
        menu.addItem(.separator())
        if Updater.shared.isAvailable {
            let update = NSMenuItem(title: "Check for Updates…", action: #selector(Updater.checkForUpdates(_:)), keyEquivalent: "")
            update.target = Updater.shared
            menu.addItem(update)
        }
        let quit = item("Quit Reel", #selector(quit))
        quit.keyEquivalent = "q"
        menu.addItem(quit)
    }

    private func item(_ title: String, _ action: Selector) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
        i.target = self
        return i
    }

    @objc private func startRecording() { RecorderController.shared.start() }
    @objc private func stopRecording() { RecorderController.shared.stop() }
    @objc private func pauseResume() { RecorderController.shared.pauseResume() }
    @objc private func restartRecording() { RecorderController.shared.restart() }
    @objc private func cancelRecording() { RecorderController.shared.cancel() }
    @objc private func toggleBubble() { RecorderController.shared.toggleBubble() }
    @objc private func toggleDrawing() { RecorderController.shared.toggleDrawing() }
    @objc private func selectDisplay(_ sender: NSMenuItem) {
        model.settings.displayID = (sender.representedObject as? NSNumber)?.uint32Value
        RecorderController.shared.displayChanged()
    }
    @objc private func signIn() { showSettings(); Task { await model.signIn() } }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func copyLastLink() { if let r = model.recordings.first { Publisher.shared.copyLink(r) } }

    @objc private func selectMode(_ sender: NSMenuItem) {
        if let raw = sender.representedObject as? String, let m = CaptureMode(rawValue: raw) { model.settings.mode = m }
    }
    @objc private func selectCamera(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String {
            model.settings.cameraEnabled = true
            model.settings.cameraID = id
            if RecorderController.shared.isBubbleVisible { RecorderController.shared.showBubble() }
        } else {
            model.settings.cameraEnabled = false
            RecorderController.shared.hideBubble()
        }
    }
    @objc private func selectMic(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String {
            model.settings.microphoneID = id
            if !model.settings.audio.usesMic { model.settings.audio = model.settings.audio == .systemOnly ? .micAndSystem : .micOnly }
        }
    }
    @objc private func selectAudio(_ sender: NSMenuItem) {
        if let raw = sender.representedObject as? String, let a = AudioSource(rawValue: raw) { model.settings.audio = a }
    }

    @objc func showMeetingWorkspace() {
        popover?.performClose(nil)
        if workspaceWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 780),
                                  styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            window.title = "Reel — Meetings"
            window.minSize = NSSize(width: 1060, height: 620)
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: MeetingWorkspaceView(model: model, showRecorder: { [weak self] in
                self?.presentRecorderPanel()
            }))
            window.center()
            window.setFrameAutosaveName("ReelMeetingWorkspace")
            workspaceWindow = window
        }
        model.reloadLibrary()
        NSApp.activate(ignoringOtherApps: true)
        workspaceWindow?.makeKeyAndOrderFront(nil)
    }

    @objc func showLibrary() {
        if libraryWindow == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 520), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            w.title = "Screen Recordings"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: LibraryView(model: model))
            w.center()
            w.setFrameAutosaveName("ReelLibrary")
            libraryWindow = w
        }
        model.reloadLibrary()
        NSApp.activate(ignoringOtherApps: true)
        libraryWindow?.makeKeyAndOrderFront(nil)
    }

    @objc func showMeetings() {
        if meetingsWindow == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 800), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            w.title = "Reel Meeting Calendars"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: MeetingCalendarsView(model: model))
            w.center()
            meetingsWindow = w
        }
        NSApp.activate(ignoringOtherApps: true)
        meetingsWindow?.makeKeyAndOrderFront(nil)
    }

    @objc func showMeetingSetup() {
        guard model.phase == .idle else { return }
        popover?.performClose(nil)
        meetingSetupModel?.cancelPendingActions()
        let setup = MeetingSetupModel()
        meetingSetupModel = setup
        if meetingSetupWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 560),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Set Up Automatic Meetings"
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.center()
            meetingSetupWindow = window
        }
        let finishSetup: () -> Void = { [weak self] in
            self?.meetingSetupWindow?.close()
            self?.showMeetingWorkspace()
        }
        meetingSetupWindow?.contentView = NSHostingView(rootView: MeetingSetupView(
            setup: setup,
            onFinish: finishSetup,
            onLater: finishSetup,
            onManageCalendars: { [weak self] in self?.showMeetings() }))
        NSApp.activate(ignoringOtherApps: true)
        meetingSetupWindow?.makeKeyAndOrderFront(nil)
        // Presentation is separate from permission/recording consent. Closing or Later
        // never enables joining, and the guide stays available from the recorder/menu.
        OrganizationState.defaults.set(MeetingSetupIntroduction.currentVersion, forKey: MeetingSetupIntroduction.defaultsKey)
    }

    func windowWillClose(_ notification: Notification) {
        if let window = notification.object as? NSWindow, window === meetingSetupWindow {
            meetingSetupModel?.cancelPendingActions()
        }
    }

    @objc func showSettings() {
        if settingsWindow == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 680), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = "Reel Settings"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: SettingsView(model: model))
            w.center()
            settingsWindow = w
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
    }
}
