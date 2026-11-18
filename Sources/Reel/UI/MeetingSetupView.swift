import AppKit
import SwiftUI

struct MeetingSetupView: View {
    @ObservedObject var setup: MeetingSetupModel
    let onFinish: () -> Void
    let onLater: () -> Void
    let onManageCalendars: () -> Void

    private let steps = [
        (title: "Calendars", icon: "calendar"),
        (title: "Recording", icon: "macwindow"),
        (title: "Joining", icon: "cursorarrow.click"),
        (title: "Review", icon: "checkmark.shield")
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Text("Join in Chrome on this Mac").font(.title2.weight(.semibold))
                Text("Use Chrome on this Mac for eligible calendar meetings. The Reel notetaker joins supported Google Meet and Teams calls even when your Mac is closed.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !showResult {
                progressStrip
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if showResult {
                        setupCard(setup.enabled ? "Joining in Chrome is on" : "Joining in Chrome is paused",
                                  icon: "checkmark.circle",
                                  detail: setup.enabled
                                      ? "Keep Reel open and this Mac awake. Chrome may ask you to sign in or wait for the host."
                                      : "Setup is complete. Resume joining in Meeting calendars when you’re ready.",
                                  state: .ready) {
                            Button("Manage calendars…", action: onManageCalendars)
                        }
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
            }

            Divider()
            footer
        }
        .padding(24)
        .frame(width: 620, height: 560)
        .task { await setup.monitorForeground() }
    }

    private var showResult: Bool { setup.completed || setup.enabled }

    private var progressStrip: some View {
        HStack(spacing: 8) {
            ForEach(steps.indices, id: \.self) { index in
                let step = steps[index]
                let current = setup.step == index
                Label(step.title, systemImage: step.icon)
                    .font(.subheadline.weight(current ? .semibold : .regular))
                    .foregroundStyle(current ? Color.accentColor : Color.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(current ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.07),
                                in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \(setup.step + 1) of \(steps.count), \(steps[setup.step].title)")
    }

    private var footer: some View {
        HStack {
            if !showResult {
                Button("Skip setup", action: onLater)
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
                    Button("Complete setup") { setup.complete() }
                        .disabled(setup.busy || !setup.readiness.isReady || !setup.participantConsent)
                        .keyboardShortcut(.defaultAction)
                        .buttonStyle(.borderedProminent)
                }
            }
        }
    }

    private var calendars: some View {
        let detail = setup.calendarAccessAllowed
            ? "\(setup.selectedCalendarCount) of \(setup.calendarCount) calendars included · \(setup.meetingCount) meetings in the next 7 days"
            : "Allow full calendar access so Reel can find Google Meet, Zoom and Teams links."
        return VStack(alignment: .leading, spacing: 12) {
            setupCard("Apple Calendar", icon: "calendar", detail: detail, state: .requirement(setup.calendarAccessAllowed && setup.selectedCalendarCount > 0)) {
                if setup.calendarAccessAllowed && setup.selectedCalendarCount == 0 {
                    Text("Choose an available calendar or add an account in Apple Calendar.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                HStack {
                    if setup.calendarNeedsSettings {
                        Button("Open calendar permissions") { setup.openSettings("Privacy_Calendars") }
                    } else if !setup.calendarAccessAllowed {
                        Button("Allow calendar access") { setup.connectCalendars() }.disabled(setup.busy)
                    } else {
                        Button("Choose calendars…", action: onManageCalendars)
                    }
                    Button("Open Apple Calendar") { setup.openCalendar() }
                    if setup.calendarAccessAllowed {
                        Button("Refresh") { setup.refreshCalendars() }.disabled(setup.busy)
                    }
                }
            }
            setupCard("Reel-connected Google Calendar", icon: "cloud",
                      detail: "Calendars connected on the Reel website are included separately. Manage that connection on the website.") {
                EmptyView()
            }
        }
    }

    private var screenRecording: some View {
        setupCard("Screen & System Audio Recording", icon: "macwindow",
                  detail: "Reel records the meeting window and computer sound. Your camera and microphone stay off.",
                  state: .requirement(setup.screenCaptureVerified)) {
            HStack {
                Button("Check access") { setup.checkScreenRecording() }.disabled(setup.busy)
                Button("Open recording permissions") { setup.openSettings("Privacy_ScreenCapture") }
            }
            Text("If macOS asks you to restart Reel after granting access, reopen this guide from the Reel menu.")
                .font(.callout).foregroundStyle(.secondary)
            Button("Quit and reopen Reel") { AppDelegate.relaunch() }.disabled(setup.busy)
        }
    }

    private var accessibilityAndChrome: some View {
        VStack(alignment: .leading, spacing: 12) {
            setupCard("Accessibility", icon: "cursorarrow.click",
                      detail: "Allows Reel to use the meeting’s join controls in Chrome.",
                      state: .requirement(setup.accessibilityAllowed)) {
                if !setup.accessibilityAllowed {
                    Button("Allow Accessibility…") { setup.requestAccessibility() }
                }
            }
            setupCard("Google Chrome", icon: "globe",
                      detail: "Open the Chrome profile you use for meetings and sign in to your meeting services.",
                      state: .requirement(setup.chromeAvailable)) {
                if setup.chromeAvailable {
                    Button("Open Chrome") { setup.openChrome() }
                } else {
                    Link("Get Google Chrome", destination: URL(string: "https://www.google.com/chrome/")!)
                }
            }
        }
    }

    private var review: some View {
        VStack(alignment: .leading, spacing: 12) {
            setupCard("Setup checklist", icon: "list.bullet") {
                Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 8) {
                    GridRow {
                        requirement("Apple Calendar", ready: setup.calendarAccessAllowed && setup.selectedCalendarCount > 0, step: 0)
                        requirement("Screen and system audio", ready: setup.screenCaptureVerified, step: 1)
                    }
                    GridRow {
                        requirement("Accessibility", ready: setup.accessibilityAllowed, step: 2)
                        requirement("Google Chrome", ready: setup.chromeAvailable, step: 2)
                    }
                }
            }
            setupCard("Recording and consent", icon: "checkmark.shield",
                      detail: "Video stays on this Mac. When you’re signed in to Reel, meeting audio is sent to OpenAI for transcription and AI notes.") {
                Text(setup.willEnableJoining
                    ? "Completing setup turns on Chrome joining. Keep Reel open and this Mac awake. You can pause Chrome joining in Meeting calendars."
                    : "Chrome joining is paused. Completing setup saves your consent so you can resume joining in Meeting calendars.")
                    .font(.callout).foregroundStyle(.secondary)
                Toggle("Participants in my included Apple and Reel-connected Google calendars have agreed to automatic recording.",
                       isOn: $setup.participantConsent)
                    .toggleStyle(.checkbox)
                    .fixedSize(horizontal: false, vertical: true)
                    .disabled(setup.busy)
            }
        }
    }

    private func requirement(_ title: String, ready: Bool, step: Int) -> some View {
        Button { setup.step = step } label: {
            readinessLabel(title, ready: ready)
        }
        .buttonStyle(.plain)
        .disabled(setup.busy)
        .accessibilityHint("Opens this setup step")
    }

    private enum CardState {
        case information, ready, attention

        static func requirement(_ ready: Bool) -> Self {
            ready ? .ready : .attention
        }
    }

    private func setupCard<Content: View>(_ title: String, icon: String, detail: String? = nil,
                                          state: CardState = .information,
                                          @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(Color.accentColor)
                .frame(width: 38, height: 38)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(title).font(.headline)
                    Spacer(minLength: 8)
                    if state != .information {
                        readinessLabel(state == .ready ? "Ready" : "Needs attention", ready: state == .ready)
                    }
                }
                if let detail {
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                content()
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
    }

    private func readinessLabel(_ title: String, ready: Bool) -> some View {
        Label(title, systemImage: ready ? "checkmark.circle.fill" : "exclamationmark.circle")
            .font(.callout)
            .foregroundStyle(ready ? Color.green : Color.secondary)
            .accessibilityLabel(title == "Ready" || title == "Needs attention" ? title :
                "\(title), \(ready ? "ready" : "needs attention")")
    }
}
