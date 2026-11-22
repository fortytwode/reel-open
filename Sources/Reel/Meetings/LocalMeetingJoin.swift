import AppKit
import ApplicationServices
import CoreGraphics
import os
import ReelCore

/// Uses Chrome's existing signed-in profile. No credentials, browser scripting, or cloud bot.
@MainActor
enum LocalMeetingJoin {
    private static var ownedCalls: [CGWindowID: (AXUIElement, MeetingLink, pid_t, AXUIElement)] = [:]
    private static var zoomNoticeAttempted: Set<CGWindowID> = []
    private static let log = Logger(subsystem: Log.subsystem, category: "meeting_join")

    private static func manual(_ code: String) -> Outcome {
        log.notice("Manual meeting entry: \(code, privacy: .public)")
        return .manualInteractionRequired
    }

    private static func windowFailure(_ code: String) -> JoinError {
        log.error("Chrome meeting window unavailable: \(code, privacy: .public)")
        return .dedicatedWindowUnavailable
    }

    static func isStillInCall(windowID: CGWindowID) -> Bool? {
        guard AXIsProcessTrusted() else { return nil }
        guard let (window, link, pid, tab) = ownedCalls[windowID] else { return false }
        guard let current = chromeWindows(pid: pid) else { return nil }
        guard current.contains(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID }) else { return false }
        guard let selected = selectedBrowserTab(window) else { return nil }
        guard CFEqual(selected, tab) else { return false }
        let nodes = descendants(window)
        guard !nodes.isEmpty else { return nil }
        guard let sameAddress = matchesWindow(window, nodes: nodes, expected: link) else { return nil }
        guard sameAddress else { return false }
        if link.platform == .zoom,
           dismissZoomTranscriptNotice(application: AXUIElementCreateApplication(pid), window: window, tab: tab,
                                       id: windowID, pid: pid, link: link, nodes: nodes) { return nil }
        let controls = nodes.filter { string($0, kAXRoleAttribute) == kAXButtonRole }.map(label)
        if MeetingCallControls.active(platform: link.platform, labels: controls) { return true }
        if nodes.map(label).contains(where: { ["you left the meeting", "meeting has ended", "this meeting has ended"].contains($0) }) { return false }
        return nil
    }

    /// Only closes the exact tab bound by this join, after revalidating its meeting.
    static func closeOwned(windowID: CGWindowID) {
        zoomNoticeAttempted.remove(windowID)
        guard let (window, link, pid, tab) = ownedCalls.removeValue(forKey: windowID) else { return }
        if !closeOwnedTab(window: window, tab: tab, link: link, id: windowID, pid: pid, selectIfNeeded: true) {
            log.info("Meeting tab cleanup unavailable")
        }
    }

    static func forget(windowID: CGWindowID) {
        ownedCalls.removeValue(forKey: windowID)
        zoomNoticeAttempted.remove(windowID)
    }
    enum Outcome {
        case joined(windowID: CGWindowID)
        case awaitingAdmission
        case signInRequired
        case manualInteractionRequired
        case timedOut
    }

    enum JoinError: LocalizedError {
        case consentRequired, invalidMeetingURL, chromeUnavailable, accessibilityPermissionRequired
        case dedicatedWindowUnavailable, admissionDenied

        var errorDescription: String? {
            switch self {
            case .consentRequired: return "Confirm participant consent before opening or joining the meeting."
            case .invalidMeetingURL: return "Use a direct Google Meet, Zoom, or Microsoft Teams meeting link."
            case .chromeUnavailable: return "Google Chrome is required to join with your signed-in browser profile."
            case .accessibilityPermissionRequired: return "Allow Reel in System Settings → Privacy & Security → Accessibility, then try again."
            case .dedicatedWindowUnavailable: return "Chrome was not ready to open a dedicated meeting window."
            case .admissionDenied: return "The meeting did not admit you. Check access with the organizer before trying again."
            }
        }

        /// The caller may offer an explicit button; this helper never opens Settings or prompts.
        var settingsURL: URL? {
            guard case .accessibilityPermissionRequired = self else { return nil }
            return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        }
    }

    static func join(url: URL, consentConfirmed: Bool, closeOnFailure: Bool = false,
                     onStatus: ((String) -> Void)? = nil) async throws -> Outcome {
        try Task.checkCancellation()
        guard consentConfirmed else { throw JoinError.consentRequired }
        guard let link = MeetingLinkParser.parse(url.absoluteString) else { throw JoinError.invalidMeetingURL }
        return try await joinDedicated(expected: link, entryURL: link.url, allowStandaloneHop: true,
                                       closeOnFailure: closeOnFailure, onStatus: onStatus)
    }

    private static func joinDedicated(expected link: MeetingLink, entryURL: URL, allowStandaloneHop: Bool,
                                      closeOnFailure: Bool, onStatus: ((String) -> Void)?) async throws -> Outcome {
        try Task.checkCancellation()
        guard AXIsProcessTrusted() else { throw JoinError.accessibilityPermissionRequired }
        guard let chromeURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") else {
            throw JoinError.chromeUnavailable
        }
        onStatus?("Opening meeting")

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        let chrome = try await NSWorkspace.shared.openApplication(at: chromeURL, configuration: configuration)
        try Task.checkCancellation()
        NSApp.yieldActivation(to: chrome)
        _ = chrome.activate(options: [])
        for _ in 0..<20 {
            try Task.checkCancellation()
            if chrome.isActive { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard chrome.isActive else { throw windowFailure("activation_unavailable") }
        let application = AXUIElementCreateApplication(chrome.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 1)
        // Chromium supports this assistive-technology request, but describes the
        // attribute as undocumented; failure leaves all identity checks in force.
        let enhancedAX = AXUIElementSetAttributeValue(application, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        if enhancedAX != .success { log.info("Chrome enhanced accessibility request unavailable code=\(enhancedAX.rawValue)") }
        guard let baseline = windowSnapshot(application: application, pid: chrome.processIdentifier) else {
            throw windowFailure("window_snapshot_unavailable")
        }
        let previousWindows = baseline.ax
        let previousIDs = baseline.ids
        // Only inspect the application menu here, never unrelated browser tab contents.
        guard let menuBar = element(application, kAXMenuBarAttribute),
              let fileMenu = elements(menuBar, kAXChildrenAttribute).first(where: { string($0, kAXTitleAttribute) == "File" }),
              let newWindow = descendants(fileMenu).first(where: { string($0, kAXTitleAttribute) == "New Window" }) else {
            throw windowFailure("new_window_menu_unavailable")
        }
        guard attribute(newWindow, kAXEnabledAttribute) as? Bool != false,
              AXUIElementPerformAction(newWindow, kAXPressAction as CFString) == .success else {
            throw windowFailure("new_window_action_unavailable")
        }
        var dedicatedWindow: AXUIElement?
        var dedicatedID: CGWindowID?
        for _ in 0..<20 {
            try Task.checkCancellation()
            guard let current = windowSnapshot(application: application, pid: chrome.processIdentifier) else {
                try await Task.sleep(for: .milliseconds(100))
                continue
            }
            let newAX = current.ax.filter { candidate in
                !previousWindows.contains(where: { CFEqual($0, candidate) })
            }
            let newCG = current.cg.filter { info in
                guard let id = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { return false }
                return !previousIDs.contains(id) && (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
            }
            guard newAX.count <= 1 else {
                log.info("Meeting window lookup: ambiguous newAX=\(newAX.count) newCG=\(newCG.count) matchingCG=not_checked")
                throw windowFailure("created_window_ambiguous")
            }
            if let window = newAX.first {
                AXUIElementSetMessagingTimeout(window, 1)
                guard newCG.allSatisfy({ info in
                    guard let bounds = info[kCGWindowBounds as String] as? [String: Any] else { return false }
                    return CGRect(dictionaryRepresentation: bounds as CFDictionary) != nil
                }) else {
                    try await Task.sleep(for: .milliseconds(100))
                    continue
                }
                guard let frame = windowBounds(window) else {
                    try await Task.sleep(for: .milliseconds(100))
                    continue
                }
                let matchingCG = newCG.filter { boundsMatch(frame, info: $0) }
                guard matchingCG.count <= 1 else {
                    log.info("Meeting window lookup: ambiguous newAX=\(newAX.count) newCG=\(newCG.count) matchingCG=\(matchingCG.count)")
                    throw windowFailure("created_window_ambiguous")
                }
                if let info = matchingCG.first,
                   let id = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value {
                    dedicatedWindow = window
                    dedicatedID = id
                    break
                }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard let window = dedicatedWindow, let id = dedicatedID else { throw windowFailure("created_window_unavailable") }
        zoomNoticeAttempted.remove(id)
        defer { if ownedCalls[id] == nil { zoomNoticeAttempted.remove(id) } }
        log.info("Meeting window lookup: bound unique new window")
        var windowClosingForHop = false
        var ownedTab: AXUIElement?
        var tabValidated = false
        var previousTabsForCleanup: [AXUIElement]?
        var reusableTabForCleanup: AXUIElement?
        var openRequested = false
        defer {
            if !windowClosingForHop, Task.isCancelled || (closeOnFailure && ownedCalls[id] == nil) {
                // The open request may have completed just as cancellation arrived.
                if openRequested, ownedTab == nil, let previous = previousTabsForCleanup, let tabs = browserTabs(window) {
                    let added = tabs.filter { tab in !previous.contains(where: { CFEqual($0, tab) }) }
                    let missing = previous.filter { prior in !tabs.contains(where: { CFEqual($0, prior) }) }
                    let safeReplacement = reusableTabForCleanup != nil && previous.count == 1 && tabs.count == 1 && missing.count == 1 && added.count == 1
                    if (missing.isEmpty || safeReplacement), added.count == 1,
                       let selected = selectedBrowserTab(window), CFEqual(added[0], selected) {
                        ownedTab = added[0]
                    } else if added.isEmpty, tabs.count == 1, let reusable = reusableTabForCleanup,
                              CFEqual(tabs[0], reusable), let selected = selectedBrowserTab(window), CFEqual(selected, reusable) {
                        ownedTab = reusable
                    }
                }
                if let ownedTab {
                    _ = closeOwnedTab(window: window, tab: ownedTab, link: link, id: id, pid: chrome.processIdentifier,
                                      selectIfNeeded: false, allowNewTabPage: !tabValidated)
                }
            }
        }
        AXUIElementSetMessagingTimeout(window, 1)
        guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else {
            throw windowFailure("created_window_raise_failed")
        }
        var stableTabs: [AXUIElement]?
        var stablePage = "unreadable"
        let baselineDeadline = Date().addingTimeInterval(3)
        while Date() < baselineDeadline {
            try Task.checkCancellation()
            if let first = browserTabs(window) {
                let firstPage = preOpenPageCategory(window, expected: link)
                if firstPage != "unreadable", let second = browserTabs(window), first.count == second.count,
                   first.allSatisfy({ prior in second.contains(where: { CFEqual($0, prior) }) }),
                   firstPage == preOpenPageCategory(window, expected: link) {
                    stableTabs = second
                    stablePage = firstPage
                    break
                }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard let previousTabs = stableTabs else {
            log.info("Meeting tab baseline unavailable: page=unreadable_or_unstable")
            return manual("tab_snapshot_unavailable")
        }
        log.info("Meeting tab baseline: prior=\(previousTabs.count) page=\(stablePage, privacy: .public)")
        let reusableTab: AXUIElement?
        if stablePage == "known_ntp", previousTabs.count == 1,
           let selected = selectedBrowserTab(window), CFEqual(previousTabs[0], selected) { reusableTab = selected }
        else { reusableTab = nil }
        previousTabsForCleanup = previousTabs
        reusableTabForCleanup = reusableTab
        try Task.checkCancellation()
        openRequested = true
        _ = try await NSWorkspace.shared.open([entryURL], withApplicationAt: chromeURL, configuration: configuration)
        let tabDeadline = Date().addingTimeInterval(10)
        while Date() < tabDeadline {
            if let tabs = browserTabs(window) {
                let added = tabs.filter { tab in !previousTabs.contains(where: { CFEqual($0, tab) }) }
                let missing = previousTabs.filter { prior in !tabs.contains(where: { CFEqual($0, prior) }) }
                let safeReplacement = reusableTab != nil && previousTabs.count == 1 && tabs.count == 1 && missing.count == 1 && added.count == 1
                guard missing.isEmpty || safeReplacement else {
                    log.info("Meeting tab changed: prior=\(previousTabs.count) current=\(tabs.count) added=\(added.count) missing=\(missing.count) page=\(stablePage, privacy: .public)")
                    return manual("tab_snapshot_changed")
                }
                guard added.count <= 1 else {
                    log.info("Meeting tab ambiguous: prior=\(previousTabs.count) current=\(tabs.count) added=\(added.count) missing=\(missing.count) page=\(stablePage, privacy: .public)")
                    return manual("tab_snapshot_ambiguous")
                }
                if let tab = added.first, let selected = selectedBrowserTab(window), CFEqual(tab, selected) {
                    if let ownedTab, !CFEqual(ownedTab, tab) { return manual("tab_snapshot_changed") }
                    ownedTab = tab
                } else if added.isEmpty, let reusableTab, let selected = selectedBrowserTab(window), CFEqual(reusableTab, selected),
                          meetAddressCheck(window, expected: link) == .match {
                    ownedTab = reusableTab
                }
                if let ownedTab, let selected = selectedBrowserTab(window), CFEqual(ownedTab, selected),
                   meetAddressCheck(window, expected: link) == .match {
                    tabValidated = true
                    break
                }
            }
            try Task.checkCancellation()
            try await Task.sleep(for: .milliseconds(100))
        }
        guard tabValidated, let ownedTab else { return manual("meeting_tab_unavailable") }
        let deadline = Date().addingTimeInterval(90)
        var requestedAdmission = false
        var mediaOffConfirmed = false
        var sawAdmissionLobby = false
        var lastDiagnosticState: String?
        var zoomFocusAttempted = false
        var timeoutCode = link.platform == .googleMeet ? "address_unavailable" : "entry_unconfirmed"
        while Date() < deadline {
            try Task.checkCancellation()
            guard AXIsProcessTrusted() else { throw JoinError.accessibilityPermissionRequired }
            guard elements(application, kAXWindowsAttribute).contains(where: { CFEqual($0, window) }) else {
                return manual("window_not_owned")
            }
            guard let currentTab = selectedBrowserTab(window), CFEqual(currentTab, ownedTab) else {
                return manual("meeting_tab_not_selected")
            }
            let nodes = descendants(window)
            let address = meetAddressCheck(window, expected: link)
            timeoutCode = address.code
            if address == .match {
                if allowStandaloneHop, link.platform == .zoom,
                   let candidate = standaloneFrameURL(window, expected: link), let target = URL(string: candidate) {
                    guard ownedForStandaloneHop(application: application, window: window, id: id, pid: chrome.processIdentifier, expected: link) else {
                        return manual("standalone_window_unverified")
                    }
                    guard let originalTab = selectedBrowserTab(window), CFEqual(originalTab, ownedTab),
                          let closeButton = tabCloseButton(ownedTab) else { return manual("standalone_tab_or_close_unavailable") }
                    guard ownedForStandaloneHop(application: application, window: window, id: id, pid: chrome.processIdentifier, expected: link),
                          let currentTab = selectedBrowserTab(window), CFEqual(originalTab, currentTab),
                          let currentClose = tabCloseButton(originalTab), CFEqual(closeButton, currentClose) else {
                        return manual("standalone_tab_changed")
                    }
                    windowClosingForHop = true
                    guard AXUIElementPerformAction(closeButton, kAXPressAction as CFString) == .success else {
                        return manual("standalone_close_failed")
                    }
                    var disappeared = false
                    for _ in 0..<20 {
                        try Task.checkCancellation()
                        if let tabs = browserTabs(window), !tabs.contains(where: { CFEqual($0, originalTab) }) {
                            disappeared = true
                            break
                        }
                        if let windows = attribute(application, kAXWindowsAttribute) as? [AXUIElement],
                           let cgWindows = chromeWindows(pid: chrome.processIdentifier),
                           !windows.contains(where: { CFEqual($0, window) }),
                           !cgWindows.contains(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }) {
                            disappeared = true
                            break
                        }
                        try await Task.sleep(for: .milliseconds(100))
                    }
                    guard disappeared else { return manual("standalone_close_unconfirmed") }
                    log.info("Zoom standalone navigation: original tab closed")
                    return try await joinDedicated(expected: link, entryURL: target, allowStandaloneHop: false,
                                                   closeOnFailure: closeOnFailure, onStatus: onStatus)
                }
                if link.platform == .zoom,
                   dismissZoomTranscriptNotice(application: application, window: window, tab: ownedTab,
                                               id: id, pid: chrome.processIdentifier, link: link, nodes: nodes) {
                    try await Task.sleep(for: .milliseconds(350))
                    continue
                }
                timeoutCode = "media_off_unrecognized"
                let labels = nodes.map(label)
                let controls = nodes.filter { node in
                    let role = string(node, kAXRoleAttribute)
                    return role == kAXButtonRole || role == "AXLink"
                }
                let controlLabels = controls.filter { string($0, kAXRoleAttribute) == kAXButtonRole }.map(label)
                let noMediaButton = controls.first(where: { label($0) == "continue without microphone and camera" })
                let callActive = MeetingCallControls.active(platform: link.platform, labels: controlLabels)
                let diagnosticState = "\(nodes.count):\(controls.count):\(noMediaButton != nil):\(callActive):\(mediaOffConfirmed)"
                if diagnosticState != lastDiagnosticState {
                    lastDiagnosticState = diagnosticState
                    log.info("Join controls changed: nodes=\(nodes.count, privacy: .public) controls=\(controls.count, privacy: .public) noMedia=\(noMediaButton != nil, privacy: .public) active=\(callActive, privacy: .public) mediaOff=\(mediaOffConfirmed, privacy: .public)")
                }
                // Never accept an active call while known inputs are on, even if an earlier
                // no-media continuation succeeded.
                let micOn = controls.first { isPrefix(label($0), ["turn off microphone", "mute microphone", "mute my microphone"]) }
                let cameraOn = controls.first { isPrefix(label($0), ["turn off camera", "stop video"]) }
                if let micOn { guard press(micOn) else { return manual("mic_press_failed") } }
                if let cameraOn { guard press(cameraOn) else { return manual("camera_press_failed") } }
                if micOn != nil || cameraOn != nil {
                    mediaOffConfirmed = false
                    timeoutCode = "media_turning_off"
                    try await Task.sleep(for: .milliseconds(350))
                    continue
                }
                if let noMediaButton {
                    guard press(noMediaButton) else { return manual("no_media_press_failed") }
                    mediaOffConfirmed = true
                    try await Task.sleep(for: .milliseconds(350))
                    continue
                }
                if link.platform == .zoom, callActive, !mediaOffConfirmed, noMediaButton == nil, !zoomFocusAttempted {
                    let candidates = controls.filter {
                        string($0, kAXRoleAttribute) == kAXButtonRole && isZoomParticipantsLabel(label($0))
                    }
                    if candidates.count == 1, let page = zoomMeetingPage(nodes, expected: link),
                       verifiedZoomFocusButton(candidates[0], page: page, window: window),
                       ownedForStandaloneHop(application: application, window: window, id: id,
                                             pid: chrome.processIdentifier, expected: link),
                       let selected = selectedBrowserTab(window), CFEqual(selected, ownedTab),
                       let focusedWindow = element(application, kAXFocusedWindowAttribute), CFEqual(focusedWindow, window) {
                        // The modal can appear while ownership checks run; require fresh call controls.
                        let currentNodes = descendants(window)
                        let currentButtons = currentNodes.filter { string($0, kAXRoleAttribute) == kAXButtonRole }
                        let currentCandidates = currentButtons.filter { isZoomParticipantsLabel(label($0)) }
                        if let currentPage = zoomMeetingPage(currentNodes, expected: link), CFEqual(page, currentPage),
                           currentCandidates.count == 1, CFEqual(currentCandidates[0], candidates[0]),
                           !currentNodes.contains(where: { label($0) == "continue without microphone and camera" }),
                           MeetingCallControls.active(platform: link.platform, labels: currentButtons.map(label)),
                           verifiedZoomFocusButton(currentCandidates[0], page: currentPage, window: window),
                           ownedForStandaloneHop(application: application, window: window, id: id,
                                                 pid: chrome.processIdentifier, expected: link),
                           let selected = selectedBrowserTab(window), CFEqual(selected, ownedTab),
                           let focusedWindow = element(application, kAXFocusedWindowAttribute), CFEqual(focusedWindow, window) {
                            zoomFocusAttempted = true
                            let frontmostBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier
                            let result = AXUIElementSetAttributeValue(currentCandidates[0], kAXFocusedAttribute as CFString, kCFBooleanTrue)
                            try await Task.sleep(for: .milliseconds(350))
                            let frontmostUnchanged = NSWorkspace.shared.frontmostApplication?.processIdentifier == frontmostBefore
                            log.info("Zoom accessibility focus attempt: code=\(result.rawValue, privacy: .public) frontmostUnchanged=\(frontmostUnchanged, privacy: .public)")
                            continue
                        }
                    }
                }
                if callActive {
                    guard MeetingCallControls.mediaOff(labels: controlLabels, continuedWithoutMedia: mediaOffConfirmed) else {
                        // Zoom can expose call controls briefly before its media prompt finishes loading.
                        timeoutCode = "media_off_unrecognized"
                        try await Task.sleep(for: .milliseconds(350))
                        continue
                    }
                    guard let current = chromeWindows(pid: chrome.processIdentifier),
                          let info = current.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }),
                          let frame = windowBounds(window), boundsMatch(frame, info: info) else { return manual("window_id_unavailable") }
                    ownedCalls[id] = (window, link, chrome.processIdentifier, ownedTab)
                    onStatus?("Joined")
                    return .joined(windowID: id)
                }
                if labels.contains(where: isDenialLabel) { throw JoinError.admissionDenied }
                let inLobby = labels.contains(where: isAdmissionLabel)
                if inLobby {
                    if !sawAdmissionLobby { onStatus?("Waiting for host admission") }
                    sawAdmissionLobby = true
                    requestedAdmission = true
                }
                if labels.contains(where: {
                    $0 == "sign in" || $0.hasPrefix("sign in to join") || $0 == "your name" ||
                    $0.contains("enter your name") || $0.contains("what's your name")
                }) {
                    return .signInRequired
                }
                if labels.contains(where: {
                    $0.contains("verify it's you") || $0.contains("enter your password") ||
                    $0.contains("allow microphone access") || $0.contains("allow camera access")
                }) { return manual("permission_or_identity_prompt") }
                if !requestedAdmission {
                    // Preserve an existing signed-in Meet session when adding the recorder.
                    if link.platform == .googleMeet, controls.contains(where: { label($0) == "switch here" }),
                       !controls.contains(where: { label($0) == "join here too" }),
                       let alternatives = controls.first(where: { label($0) == "other ways to join" }) {
                        guard press(alternatives) else { return manual("join_options_press_failed") }
                        try await Task.sleep(for: .milliseconds(350))
                        continue
                    }
                    // Continue through the provider's browser choice without launching a native app.
                    if let browserButton = controls.first(where: {
                        ["continue on this browser", "join from your browser", "join from browser", "join on the web instead"].contains(label($0))
                    }) {
                        _ = press(browserButton)
                    } else {
                        // Unknown or localized controls are not evidence that media is off.
                        if let joinButton = controls.first(where: {
                            ["join now", "join now without camera", "ask to join", "join meeting"].contains(label($0)) ||
                                (link.platform == .googleMeet && label($0) == "join here too")
                        }) {
                            guard MeetingCallControls.mediaOff(labels: controlLabels, continuedWithoutMedia: mediaOffConfirmed) else {
                                // Join can render before the media controls finish loading.
                                // Keep checking this owned tab within the existing deadline.
                                timeoutCode = "media_off_unrecognized"
                                onStatus?("Waiting for microphone and camera controls")
                                try await Task.sleep(for: .milliseconds(350))
                                continue
                            }
                            mediaOffConfirmed = true
                            guard press(joinButton) else { return manual("join_press_failed") }
                            requestedAdmission = true
                        }
                    }
                }
            }
            try await Task.sleep(for: .seconds(1))
        }
        if !sawAdmissionLobby { log.notice("Meeting entry timed out: \(timeoutCode, privacy: .public)") }
        return sawAdmissionLobby ? .awaitingAdmission : .timedOut
    }

    /// Chrome exposes native tabs as radio buttons in a tab group. Page content
    /// is pruned so an HTML tab group cannot be mistaken for the browser strip.
    private static func browserTabs(_ window: AXUIElement) -> [AXUIElement]? {
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var index = 0
        var groups: [AXUIElement] = []
        let deadline = Date().addingTimeInterval(2)
        while index < queue.count, queue.count < 1_500, Date() < deadline {
            let (node, depth) = queue[index]
            index += 1
            AXUIElementSetMessagingTimeout(node, 0.1)
            guard let role = attribute(node, kAXRoleAttribute) as? String else { return nil }
            if role == "AXWebArea" { continue }
            if role == kAXTabGroupRole { groups.append(node) }
            guard let children = checkedChildren(node), children.count <= 200,
                  depth < 25 || children.isEmpty else { return nil }
            for child in children {
                guard queue.count < 1_500 else { return nil }
                queue.append((child, depth + 1))
            }
        }
        guard index == queue.count, groups.count == 1,
              let children = checkedChildren(groups[0]), children.count <= 200 else { return nil }
        var tabs: [AXUIElement] = []
        for child in children {
            guard Date() < deadline else { return nil }
            AXUIElementSetMessagingTimeout(child, 0.1)
            guard let role = attribute(child, kAXRoleAttribute) as? String else { return nil }
            if role == kAXRadioButtonRole { tabs.append(child) }
        }
        return tabs
    }

    private static func selectedBrowserTab(_ window: AXUIElement) -> AXUIElement? {
        guard let tabs = browserTabs(window), !tabs.isEmpty else { return nil }
        var selected: [AXUIElement] = []
        for tab in tabs {
            guard let value = attribute(tab, kAXValueAttribute) as? NSNumber,
                  value.intValue == 0 || value.intValue == 1 else { return nil }
            if value.intValue == 1 { selected.append(tab) }
        }
        return selected.count == 1 ? selected[0] : nil
    }

    private static func preOpenPageCategory(_ window: AXUIElement, expected: MeetingLink) -> String {
        if isChromeNewTab(window) { return "known_ntp" }
        switch meetAddressCheck(window, expected: expected) {
        case .match: return "expected"
        case .mismatch: return "other"
        case .unavailable, .ambiguous: return "unreadable"
        }
    }

    /// Only the browser's exact built-in new-tab page qualifies for safe reuse.
    private static func isChromeNewTab(_ window: AXUIElement) -> Bool {
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var index = 0
        var pages: [String] = []
        let deadline = Date().addingTimeInterval(2)
        while index < queue.count, queue.count < 1_500, Date() < deadline {
            let (node, depth) = queue[index]
            index += 1
            AXUIElementSetMessagingTimeout(node, 0.1)
            guard let role = attribute(node, kAXRoleAttribute) as? String else { return false }
            if role == "AXWebArea" {
                guard let value = attribute(node, kAXURLAttribute) ?? attribute(node, kAXDocumentAttribute),
                      let address = (value as? URL)?.absoluteString ?? (value as? String) else { return false }
                if address != "chrome://newtab-footer/" { pages.append(address) }
                continue
            }
            guard let children = checkedChildren(node), children.count <= 200, depth < 25 || children.isEmpty else { return false }
            for child in children {
                guard queue.count < 1_500 else { return false }
                queue.append((child, depth + 1))
            }
        }
        return index == queue.count && (pages == ["chrome://newtab/"] || pages == ["chrome://newtab"])
    }

    private static func closeOwnedTab(window: AXUIElement, tab: AXUIElement, link: MeetingLink, id: CGWindowID,
                                      pid: pid_t, selectIfNeeded: Bool, allowNewTabPage: Bool = false) -> Bool {
        let application = AXUIElementCreateApplication(pid)
        guard AXIsProcessTrusted(), elements(application, kAXWindowsAttribute).contains(where: { CFEqual($0, window) }),
              let cg = chromeWindows(pid: pid), cg.contains(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }),
              let tabs = browserTabs(window), tabs.contains(where: { CFEqual($0, tab) }),
              let selected = selectedBrowserTab(window) else { return false }
        if !CFEqual(selected, tab) {
            guard selectIfNeeded else { return false }
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(tab, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue,
                  AXUIElementSetAttributeValue(tab, kAXValueAttribute as CFString, kCFBooleanTrue) == .success else { return false }
        }
        guard let current = selectedBrowserTab(window), CFEqual(tab, current),
              (meetAddressCheck(window, expected: link) == .match || (allowNewTabPage && isChromeNewTab(window))),
              let button = tabCloseButton(tab),
              let final = selectedBrowserTab(window), CFEqual(tab, final),
              (meetAddressCheck(window, expected: link) == .match || (allowNewTabPage && isChromeNewTab(window))),
              let finalButton = tabCloseButton(tab), CFEqual(button, finalButton) else { return false }
        return AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
    }

    private static func tabCloseButton(_ tab: AXUIElement) -> AXUIElement? {
        guard let children = checkedChildren(tab), children.count <= 200 else { return nil }
        var buttons: [AXUIElement] = []
        for child in children {
            AXUIElementSetMessagingTimeout(child, 0.1)
            guard let role = attribute(child, kAXRoleAttribute) as? String else { return nil }
            if role == kAXButtonRole, ["close", "close tab"].contains(label(child)) { buttons.append(child) }
        }
        return buttons.count == 1 ? buttons[0] : nil
    }

    /// Find a unique validated descendant frame and reject incomplete scans.
    private static func standaloneFrameURL(_ window: AXUIElement, expected: MeetingLink) -> String? {
        var queue: [(AXUIElement, Int, Bool)] = [(window, 0, false)]
        var index = 0
        var frameURLs: [String] = []
        var topPages: [String] = []
        let deadline = Date().addingTimeInterval(2)
        while index < queue.count, queue.count < 1_500, Date() < deadline {
            let (node, depth, inWeb) = queue[index]
            index += 1
            AXUIElementSetMessagingTimeout(node, 0.2)
            guard let role = attribute(node, kAXRoleAttribute) as? String else { return nil }
            if !inWeb, role == "AXWebArea" {
                guard let value = attribute(node, kAXURLAttribute) ?? attribute(node, kAXDocumentAttribute),
                      let address = (value as? URL)?.absoluteString ?? (value as? String) else { return nil }
                if address != "chrome://newtab-footer/" { topPages.append(address) }
            }
            if inWeb, let value = attribute(node, kAXURLAttribute) ?? attribute(node, kAXDocumentAttribute),
               let address = (value as? URL)?.absoluteString ?? (value as? String),
               MeetingLinkParser.isObservedZoomStandaloneFrame(address, expected: expected) { frameURLs.append(address) }
            guard let children = checkedChildren(node), children.count <= 200,
                  depth < 25 || children.isEmpty else { return nil }
            for child in children {
                guard queue.count < 1_500 else { return nil }
                queue.append((child, depth + 1, inWeb || role == "AXWebArea"))
            }
        }
        guard index == queue.count, topPages.count == 1,
              MeetingLinkParser.matchesObservedPage(topPages, expected: expected),
              frameURLs.count == 1, frameURLs[0] != topPages[0] else { return nil }
        return frameURLs[0]
    }

    private static func ownedForStandaloneHop(application: AXUIElement, window: AXUIElement, id: CGWindowID, pid: pid_t, expected: MeetingLink) -> Bool {
        guard AXIsProcessTrusted(), elements(application, kAXWindowsAttribute).contains(where: { CFEqual($0, window) }),
              let current = chromeWindows(pid: pid),
              let info = current.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }),
              let bounds = windowBounds(window), boundsMatch(bounds, info: info),
              meetAddressCheck(window, expected: expected) == .match else { return false }
        return true
    }

    private static func matchesWindow(_ window: AXUIElement, nodes: [AXUIElement], expected: MeetingLink) -> Bool? {
        switch meetAddressCheck(window, expected: expected) {
        case .match: return true
        case .unavailable, .ambiguous: return nil
        case .mismatch: return false
        }
    }

    private enum MeetAddressCheck: Equatable {
        case match, unavailable, mismatch, ambiguous
        var code: String {
            switch self {
            case .match: return "address_matched"
            case .unavailable: return "address_unavailable"
            case .mismatch: return "address_mismatch"
            case .ambiguous: return "address_ambiguous"
            }
        }
    }

    private static func meetAddressCheck(_ window: AXUIElement, expected: MeetingLink) -> MeetAddressCheck {
        // Stop at each top-level web area. Nested frames cannot establish page ownership.
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var index = 0
        var pages: [String] = []
        let deadline = Date().addingTimeInterval(2)
        while index < queue.count && queue.count < 1_500 && Date() < deadline {
            let (node, depth) = queue[index]
            index += 1
            var roleValue: CFTypeRef?
            guard AXUIElementCopyAttributeValue(node, kAXRoleAttribute as CFString, &roleValue) == .success,
                  let role = roleValue as? String else { return .unavailable }
            if role == "AXWebArea" {
                guard let value = attribute(node, kAXURLAttribute) ?? attribute(node, kAXDocumentAttribute),
                      let address = (value as? URL)?.absoluteString ?? (value as? String) else { return .unavailable }
                if address != "chrome://newtab-footer/" { pages.append(address) }
                continue
            }
            guard let children = checkedChildren(node) else { return .unavailable }
            if children.count > 200 || (depth >= 25 && !children.isEmpty) { return .unavailable }
            for child in children {
                if queue.count >= 1_500 { return .unavailable }
                queue.append((child, depth + 1))
            }
        }
        guard index == queue.count else { return .unavailable }
        guard pages.count == 1 else { return pages.isEmpty ? .unavailable : .ambiguous }
        if expected.platform != .googleMeet {
            return MeetingLinkParser.matchesObservedPage(pages, expected: expected) ? .match : .mismatch
        }
        guard let observed = MeetingLinkParser.parse(pages[0]),
              observed.platform == expected.platform,
              let left = URLComponents(url: expected.url, resolvingAgainstBaseURL: false),
              let right = URLComponents(url: observed.url, resolvingAgainstBaseURL: false),
              left.host == right.host else { return .mismatch }
        let leftPath = left.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let rightPath = right.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let leftQuery = left.percentEncodedQuery.map { "?" + $0 } ?? ""
        let rightQuery = right.percentEncodedQuery.map { "?" + $0 } ?? ""
        let call = { (path: String) in path.hasPrefix("meet/") ? String(path.dropFirst(5)) : path }
        guard call(leftPath) == call(rightPath),
              let first = meetIdentityQuery(leftQuery), let second = meetIdentityQuery(rightQuery) else { return .mismatch }
        return first == second ? .match : .mismatch
    }

    private static func isZoomParticipantsLabel(_ value: String) -> Bool {
        value.range(of: #"^open the (?:manage participants list pane,[0-9]+|participants list pane,\[[0-9]+\]) particpants$"#,
                    options: .regularExpression) != nil
    }

    private static func zoomMeetingPage(_ nodes: [AXUIElement], expected: MeetingLink) -> AXUIElement? {
        let pages = nodes.filter { node in
            guard string(node, kAXRoleAttribute) == "AXWebArea",
                  let value = attribute(node, kAXURLAttribute) ?? attribute(node, kAXDocumentAttribute),
                  let address = (value as? URL)?.absoluteString ?? (value as? String),
                  address != "chrome://newtab-footer/" else { return false }
            return MeetingLinkParser.matchesObservedPage([address], expected: expected)
        }
        return pages.count == 1 ? pages[0] : nil
    }

    private static func zoomTranscriptNotice(_ nodes: [AXUIElement], window: AXUIElement, link: MeetingLink) -> (AXUIElement, AXUIElement, AXUIElement)? {
        guard let page = zoomMeetingPage(nodes, expected: link) else { return nil }
        let heading = "this meeting is being transcribed."
        let sharing = "anyone with access to the transcript may view or share it with others."
        let fullMessage = heading + " " + sharing
        let groups = nodes.filter {
            string($0, kAXRoleAttribute) == "AXGroup" &&
            [sharing, fullMessage].contains(label($0))
        }
        guard groups.count == 1 else { return nil }
        // Zoom's modal puts the sharing sentence on the group and the full
        // message in static text; its inline notice uses the full group label
        // with only the heading in static text. Accept only these exact pairs.
        let expectedText = label(groups[0]) == sharing ? fullMessage : heading
        let messages = nodes.filter {
            guard string($0, kAXRoleAttribute) == "AXStaticText" else { return false }
            let value = string($0, kAXValueAttribute).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return (value.isEmpty ? label($0) : value) == expectedText
        }
        let buttons = nodes.filter { string($0, kAXRoleAttribute) == kAXButtonRole && label($0) == "ok" }
        guard messages.count == 1, buttons.count == 1,
              hasLiveAncestor(groups[0], page: page), hasLiveAncestor(messages[0], page: groups[0]),
              hasLiveAncestor(buttons[0], page: groups[0]),
              (attribute(buttons[0], kAXEnabledAttribute) as? Bool) == true,
              let buttonWindow = element(buttons[0], kAXWindowAttribute), CFEqual(buttonWindow, window) else { return nil }
        return (page, groups[0], buttons[0])
    }

    private static func dismissZoomTranscriptNotice(application: AXUIElement, window: AXUIElement, tab: AXUIElement,
                                                     id: CGWindowID, pid: pid_t, link: MeetingLink, nodes: [AXUIElement]) -> Bool {
        guard !zoomNoticeAttempted.contains(id),
              let (page, group, button) = zoomTranscriptNotice(nodes, window: window, link: link),
              ownedForStandaloneHop(application: application, window: window, id: id, pid: pid, expected: link),
              let selected = selectedBrowserTab(window), CFEqual(selected, tab),
              let (currentPage, currentGroup, currentButton) = zoomTranscriptNotice(descendants(window), window: window, link: link),
              CFEqual(page, currentPage), CFEqual(group, currentGroup), CFEqual(button, currentButton),
              ownedForStandaloneHop(application: application, window: window, id: id, pid: pid, expected: link),
              let currentTab = selectedBrowserTab(window), CFEqual(currentTab, tab) else { return false }
        zoomNoticeAttempted.insert(id)
        let result = AXUIElementPerformAction(currentButton, kAXPressAction as CFString)
        log.info("Zoom transcript notice dismissal: code=\(result.rawValue, privacy: .public)")
        return true
    }

    private static func verifiedZoomFocusButton(_ button: AXUIElement, page: AXUIElement, window: AXUIElement) -> Bool {
        guard string(button, kAXRoleAttribute) == kAXButtonRole, isZoomParticipantsLabel(label(button)),
              (attribute(button, kAXEnabledAttribute) as? Bool) == true,
              let buttonWindow = element(button, kAXWindowAttribute), CFEqual(buttonWindow, window),
              hasLiveAncestor(button, page: page) else { return false }
        var settable = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(button, kAXFocusedAttribute as CFString, &settable) == .success && settable.boolValue
    }

    private static func hasLiveAncestor(_ node: AXUIElement, page: AXUIElement) -> Bool {
        var current = node
        var seen: [AXUIElement] = [node]
        let deadline = Date().addingTimeInterval(1)
        for _ in 0..<25 {
            guard Date() < deadline, let parent = element(current, kAXParentAttribute),
                  !seen.contains(where: { CFEqual($0, parent) }) else { return false }
            if CFEqual(parent, page) { return true }
            seen.append(parent)
            current = parent
        }
        return false
    }

    private static func checkedChildren(_ node: AXUIElement) -> [AXUIElement]? {
        var value: CFTypeRef?
        switch AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &value) {
        case .success: return value as? [AXUIElement]
        case .noValue, .attributeUnsupported: return []
        default: return nil
        }
    }

    private static func meetIdentityQuery(_ query: String) -> String? {
        if query.isEmpty { return "" }
        var parts: [Substring] = []
        var routingFlag = false
        for part in query.dropFirst().split(separator: "&", omittingEmptySubsequences: false) {
            if part == "pli=1" {
                if routingFlag { return nil }
                routingFlag = true
            } else if part == "pli" || part.hasPrefix("pli=") { return nil }
            else { parts.append(part) }
        }
        return parts.isEmpty ? "" : "?" + parts.joined(separator: "&")
    }

    private static func attribute(_ item: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(item, name as CFString, &value) == .success else { return nil }
        return value
    }

    private static func string(_ item: AXUIElement, _ name: String) -> String {
        attribute(item, name) as? String ?? ""
    }

    private static func element(_ item: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(item, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private static func elements(_ item: AXUIElement, _ name: String) -> [AXUIElement] {
        attribute(item, name) as? [AXUIElement] ?? []
    }

    /// Bounded traversal; callers use this only on the File menu or the identified meeting window.
    private static func descendants(_ root: AXUIElement) -> [AXUIElement] {
        var result: [AXUIElement] = []
        var queue: [(AXUIElement, Int)] = [(root, 0)]
        var index = 0
        let deadline = Date().addingTimeInterval(2)
        while index < queue.count && result.count < 1_500 && Date() < deadline {
            let (node, depth) = queue[index]
            index += 1
            result.append(node)
            if depth < 25 {
                for child in elements(node, kAXChildrenAttribute).prefix(200) {
                    if queue.count >= 1_500 { break }
                    queue.append((child, depth + 1))
                }
            }
        }
        return result
    }

    private static func label(_ node: AXUIElement) -> String {
        let title = string(node, kAXTitleAttribute)
        let description = string(node, kAXDescriptionAttribute)
        return (title.isEmpty ? description : title).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private static func isPrefix(_ value: String, _ prefixes: [String]) -> Bool {
        prefixes.contains { value == $0 || value.hasPrefix($0 + " (") || value.hasPrefix($0 + ",") }
    }

    private static func isAdmissionLabel(_ value: String) -> Bool {
        value.contains("asking to join") || value.contains("waiting for the host") ||
        value.contains("someone will let you in") || value.contains("waiting for someone to let you in")
    }

    private static func isDenialLabel(_ value: String) -> Bool {
        value.contains("request to join was denied") || value.contains("can't join this video call") ||
        value.contains("cannot join this meeting") || value.contains("you were removed from the meeting") ||
        value.contains("you've been removed from the meeting") || value.contains("meeting has ended") ||
        value.contains("no one responded to your request")
    }

    private static func press(_ node: AXUIElement) -> Bool {
        guard string(node, kAXRoleAttribute) == kAXButtonRole || string(node, kAXRoleAttribute) == "AXLink" else { return false }
        return AXUIElementPerformAction(node, kAXPressAction as CFString) == .success
    }

    private static func windowSnapshot(application: AXUIElement, pid: pid_t) -> (ax: [AXUIElement], cg: [[String: Any]], ids: Set<CGWindowID>)? {
        guard let firstAX = attribute(application, kAXWindowsAttribute) as? [AXUIElement],
              let firstCG = chromeWindows(pid: pid),
              let secondAX = attribute(application, kAXWindowsAttribute) as? [AXUIElement],
              let secondCG = chromeWindows(pid: pid) else { return nil }
        let firstIDs = Set(firstCG.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value })
        let secondIDs = Set(secondCG.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value })
        guard firstIDs.count == firstCG.count, secondIDs.count == secondCG.count,
              firstIDs == secondIDs, firstAX.count == secondAX.count,
              firstAX.allSatisfy({ item in secondAX.contains(where: { CFEqual(item, $0) }) }) else { return nil }
        return (secondAX, secondCG, secondIDs)
    }

    private static func chromeWindows(pid: pid_t) -> [[String: Any]]? {
        guard let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        return windows.filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid }
    }

    private static func windowBounds(_ window: AXUIElement) -> CGRect? {
        guard let position = attribute(window, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
              let size = attribute(window, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
              AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
        return CGRect(origin: point, size: dimensions)
    }

    private static func boundsMatch(_ frame: CGRect, info: [String: Any]) -> Bool {
        guard let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
        return abs(rect.minX - frame.minX) < 2 && abs(rect.minY - frame.minY) < 2 &&
            abs(rect.width - frame.width) < 2 && abs(rect.height - frame.height) < 2
    }
}
