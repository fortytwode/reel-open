import AppKit
import ReelCore
import SwiftUI

struct MeetingSetupView: View {
    @ObservedObject var setup: MeetingSetupModel
    @ObservedObject private var joining = MeetingJoinCoordinator.shared
    @State private var showAppleCalendars = false
    let onFinish: () -> Void
    let onLater: () -> Void
    let onManageCalendars: () -> Void

    private let steps = [
        (title: "Choose calendars", icon: "calendar"),
        (title: "Allow recording", icon: "macwindow"),
        (title: "Connect Chrome", icon: "cursorarrow.click"),
        (title: "Review and finish", icon: "checkmark.shield")
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if showResult {
                        result
                    } else {
                        switch setup.step {
                        case 0: calendars
                        case 1: screenRecording
                        case 2: accessibilityAndChrome
                        default: review
                        }
                    }

                    if !setup.status.isEmpty {
                        Text(setup.status)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("meetingSetup.status")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .id(showResult ? steps.count : setup.step)
            }

            Divider()
            footer
        }
        .padding(24)
        .frame(width: 540, height: 390)
        .task { await setup.monitorForeground() }
    }

    private var showResult: Bool { setup.completed || setup.enabled }

    private var header: some View {
        let step = steps[setup.step]
        return VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Label(showResult ? (setup.enabled ? "Auto-join is on" : "Auto-join is paused") : step.title,
                      systemImage: showResult ? "checkmark.circle" : step.icon)
                    .font(.title2.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                if !showResult {
                    Text("\(setup.step + 1) of \(steps.count)")
                        .font(.callout.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Step \(setup.step + 1) of \(steps.count)")
                }
            }
        }
    }

    private var result: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(setup.enabled
                 ? "Keep Reel open and this Mac awake for automatic joining."
                 : "You can resume automatic joining from the meeting helper.")
                .foregroundStyle(.secondary)
            Button("Manage calendars…", action: onManageCalendars)
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if !showResult {
                Button("Later", action: onLater)
                    .help("Close setup and keep your current recording settings")
                    .keyboardShortcut(.cancelAction)
            }
            Spacer()
            if setup.busy {
                ProgressView().controlSize(.small).accessibilityLabel("Checking setup")
            }
            if showResult {
                Button("Done", action: onFinish)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            } else {
                if setup.step > 0 {
                    Button("Back") { setup.step -= 1 }.disabled(setup.busy)
                }
                if setup.step < steps.count - 1 {
                    Button("Continue") { setup.step += 1 }
                        .disabled(setup.busy)
                        .keyboardShortcut(.defaultAction)
                        .buttonStyle(.borderedProminent)
                } else {
                    Button(setup.willEnableJoining ? "Turn on auto-join" : "Save setup") { setup.complete() }
                        .disabled(setup.busy || !setup.readiness.isReady || !setup.participantConsent)
                        .keyboardShortcut(.defaultAction)
                        .buttonStyle(.borderedProminent)
                }
            }
        }
    }

    private var calendars: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let url = CloudConfig.default.notetakerURL {
                HStack {
                    Label("Google Calendar", systemImage: "calendar")
                        .font(.headline)
                    Spacer()
                    Link("Manage calendars…", destination: url)
                }
                Divider()
            }
            if setup.calendarAccessAllowed && !setup.calendars.isEmpty {
                DisclosureGroup(isExpanded: $showAppleCalendars) {
                    DesktopCalendarPicker(calendars: setup.calendars)
                        .disabled(setup.busy)
                        .padding(.top, 8)
                    HStack {
                        Button("Open Apple Calendar", action: setup.openCalendar)
                        Button("Refresh", action: setup.refreshCalendars).disabled(setup.busy)
                    }
                    .padding(.top, 5)
                } label: {
                    HStack(spacing: 8) {
                        Text("Apple Calendar").font(.headline)
                        Spacer()
                        Text(setup.selectedCalendarCount == 0 ? "Choose a calendar" : "\(setup.selectedCalendarCount) selected")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Apple Calendar").font(.headline)
                    Text(setup.calendarAccessAllowed
                         ? "Add a calendar account, then refresh."
                         : "Allow access to choose calendars for automatic joining.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    HStack {
                        if setup.calendarNeedsSettings {
                            Button("Open Calendar settings") { setup.openSettings("Privacy_Calendars") }
                        } else if !setup.calendarAccessAllowed {
                            Button("Allow access", action: setup.connectCalendars).disabled(setup.busy)
                        }
                        if setup.calendarAccessAllowed {
                            Button("Open Apple Calendar", action: setup.openCalendar)
                            Button("Refresh", action: setup.refreshCalendars).disabled(setup.busy)
                        }
                    }
                }
            }
        }
        .onChange(of: joining.desktopCalendarSelection) { _, _ in setup.refreshCalendars() }
    }

    private var screenRecording: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Allow Reel to capture the meeting window and system audio.")
                .foregroundStyle(.secondary)
            if setup.screenCaptureVerified {
                Label("Recording access ready", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }
            HStack {
                Button(setup.screenCaptureVerified ? "Check again" : "Check access", action: setup.checkScreenRecording)
                    .disabled(setup.busy)
                Button("Open System Settings") { setup.openSettings("Privacy_ScreenCapture") }
            }
            if !setup.screenCaptureVerified {
                Button("Quit and reopen Reel", action: AppDelegate.relaunch)
                    .buttonStyle(.link)
                    .help("Use this if macOS asks you to reopen Reel after granting access")
                    .disabled(setup.busy)
            }
        }
    }

    private var accessibilityAndChrome: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Accessibility").font(.headline)
                    Text("Lets Reel use Chrome’s join controls.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if setup.accessibilityAllowed {
                    Label("Ready", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                } else {
                    Button("Allow Accessibility…", action: setup.requestAccessibility).disabled(setup.busy)
                }
            }
            Divider()
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Google Chrome").font(.headline)
                    Text("Sign in with the profile you use for meetings.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if setup.chromeAvailable {
                    Button("Open Chrome", action: setup.openChrome)
                } else {
                    Link("Get Chrome", destination: URL(string: "https://www.google.com/chrome/")!)
                }
            }
        }
    }

    private var review: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !setup.readiness.isReady {
                Text("Finish setup").font(.headline)
                if !setup.calendarAccessAllowed || setup.selectedCalendarCount == 0 {
                    requirement("Set up Apple Calendar", step: 0)
                }
                if !setup.screenCaptureVerified {
                    requirement("Check screen and system audio access", step: 1)
                }
                if !setup.accessibilityAllowed {
                    requirement("Allow Accessibility", step: 2)
                }
                if !setup.chromeAvailable {
                    requirement("Install Google Chrome", step: 2)
                }
                Divider()
            }
            Toggle("Participants in meetings from my selected calendars have agreed to automatic recording.",
                   isOn: $setup.participantConsent)
                .toggleStyle(.checkbox)
                .fixedSize(horizontal: false, vertical: true)
                .disabled(setup.busy)
            VStack(alignment: .leading, spacing: 5) {
                Text("Video stays on this Mac. When you’re signed in, Reel sends meeting audio to OpenAI for transcription and notes.")
                Text(setup.willEnableJoining
                     ? "Keep Reel open and this Mac awake to join."
                     : "Auto-join stays paused until you turn it on.")
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func requirement(_ title: String, step: Int) -> some View {
        Button { setup.step = step } label: {
            Label(title, systemImage: "arrow.right.circle")
        }
        .buttonStyle(.link)
        .disabled(setup.busy)
    }
}
