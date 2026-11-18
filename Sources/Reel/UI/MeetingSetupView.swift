import AppKit
import SwiftUI

struct MeetingSetupView: View {
    @ObservedObject var setup: MeetingSetupModel
    let onFinish: () -> Void
    let onLater: () -> Void
    let onManageCalendars: () -> Void

    init(setup: MeetingSetupModel, onFinish: @escaping () -> Void, onLater: @escaping () -> Void,
         onManageCalendars: @escaping () -> Void) {
        self.setup = setup
        self.onFinish = onFinish
        self.onLater = onLater
        self.onManageCalendars = onManageCalendars
    }

    private let titles = ["Connect calendars", "Screen and system audio", "Accessibility and Chrome", "Review and enable"]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Text("Automatic meeting recording").font(.title2.weight(.semibold))
                Text("Reel can join calendar meetings in Chrome and record them on this Mac.")
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 7) {
                ForEach(0..<4) { index in
                    Capsule().fill(index <= setup.step ? Color.accentColor : Color.secondary.opacity(0.2))
                        .frame(height: 4)
                }
            }.accessibilityLabel("Step \(setup.step + 1) of 4")
            HStack {
                Text("\(setup.step + 1). \(titles[setup.step])").font(.headline)
                Spacer()
                if setup.busy { ProgressView().controlSize(.small).accessibilityLabel("Checking setup") }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if setup.enabled {
                        Label("Automatic joining is enabled", systemImage: "checkmark.circle.fill")
                            .font(.headline).foregroundStyle(.green)
                        Text("Setup permissions are configured. Keep Reel open and this Mac awake for calendar meetings.")
                        Text("Some meetings still need host admission or sign-in in Chrome.")
                            .foregroundStyle(.secondary)
                    } else {
                        switch setup.step {
                        case 0: calendars
                        case 1: screenRecording
                        case 2: accessibilityAndChrome
                        default: review
                        }
                    }
                    if !setup.status.isEmpty {
                        Text(setup.status).font(.callout).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("meetingSetup.status")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack {
                Button("Later", action: onLater).keyboardShortcut(.cancelAction)
                    .accessibilityHint("Close setup and leave automatic joining unchanged")
                Spacer()
                if setup.enabled {
                    Button("Done", action: onFinish).keyboardShortcut(.defaultAction)
                        .buttonStyle(.borderedProminent)
                } else {
                    if setup.step > 0 {
                        Button("Back") { setup.step -= 1 }.disabled(setup.busy)
                    }
                    if setup.step < 3 {
                        Button("Next") { setup.step += 1 }
                            .disabled(setup.busy || !setup.canAdvance)
                            .keyboardShortcut(.defaultAction)
                            .buttonStyle(.borderedProminent)
                    } else {
                        Button("Enable automatic joining") { setup.enable() }
                            .disabled(setup.busy || !setup.readiness.isReady || !setup.participantConsent)
                            .keyboardShortcut(.defaultAction)
                            .buttonStyle(.borderedProminent)
                    }
                }
            }
        }
        .padding(24)
        .frame(width: 620, height: 560)
        .task { await setup.monitorForeground() }
    }

    private var calendars: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Reel finds Google Meet, Zoom and Teams links in calendars synced to Apple Calendar. You can use local joining without a Reel account.")
            Text("For Google Calendar, open Apple Calendar → Settings → Accounts → Add Account → Google. Sign in and turn on Calendars, then return here.")
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                if setup.calendarNeedsSettings {
                    Button("Open calendar settings") { setup.openSettings("Privacy_Calendars") }
                } else if !setup.calendarAccessAllowed {
                    Button("Connect calendars") { setup.connectCalendars() }.disabled(setup.busy)
                }
                Button("Open Apple Calendar") { setup.openCalendar() }
                Button("Refresh") { setup.refreshCalendars() }.disabled(setup.busy)
            }
            if setup.calendarAccessAllowed {
                readinessRow("Calendar access", ready: true)
                Text("\(setup.selectedCalendarCount) of \(setup.calendarCount) desktop calendars included · \(setup.meetingCount) desktop meetings in the next 7 days")
                    .font(.callout)
                Text(setup.useAllCalendars ? "All calendars on this Mac are included, including new calendars added later." : "Your existing custom calendar selection is preserved.")
                    .font(.callout).foregroundStyle(.secondary)
                if setup.selectedCalendarCount == 0 {
                    Text("Add an account in Apple Calendar or choose at least one available calendar to continue.")
                        .font(.callout)
                }
                Button("Choose calendars…", action: onManageCalendars)
            } else {
                Text(setup.calendarNeedsSettings ? "Allow Reel in System Settings → Privacy & Security → Calendars, then return here. Full calendar access is required; write-only access cannot find meetings." : "Click Connect calendars and allow full access when macOS asks. This lets Reel find meeting links.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Text("Google Calendar connected through the Reel website is also included. Those meetings are separate from your desktop calendar selection.")
                .font(.callout).foregroundStyle(.secondary)
        }.fixedSize(horizontal: false, vertical: true)
    }

    private var screenRecording: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Allow Reel in System Settings → Privacy & Security → Screen & System Audio Recording.")
            Text("Automatic capture records the meeting window and computer sound. Your microphone is off. No camera or microphone permission is needed for automatic recording.")
                .font(.callout).foregroundStyle(.secondary)
            readinessRow("Screen and system audio access checked", ready: setup.screenCaptureVerified)
            HStack {
                Button("Check access") { setup.checkScreenRecording() }.disabled(setup.busy)
                Button("Open recording settings") { setup.openSettings("Privacy_ScreenCapture") }
            }
            Text("After you change access, macOS may require Reel to quit and reopen. You can reopen setup from the Reel menu. Checking access may show a macOS permission request.")
                .font(.callout).foregroundStyle(.secondary)
            Button("Quit and reopen Reel") { AppDelegate.relaunch() }.disabled(setup.busy)
        }.fixedSize(horizontal: false, vertical: true)
    }

    private var accessibilityAndChrome: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Reel uses Accessibility to operate the meeting's join controls in Google Chrome.")
            readinessRow("Accessibility access", ready: setup.accessibilityAllowed)
            Button("Allow Accessibility…") { setup.requestAccessibility() }
            Text("Turn on Reel in System Settings → Privacy & Security → Accessibility, then return here.")
                .font(.callout).foregroundStyle(.secondary)
            Divider()
            readinessRow("Google Chrome installed", ready: setup.chromeAvailable)
            if setup.chromeAvailable {
                Button("Open Chrome") { setup.openChrome() }
            } else {
                Link("Get Google Chrome", destination: URL(string: "https://www.google.com/chrome/")!)
            }
            Text("In Chrome, choose the profile you want Reel to use and sign in to your meeting services. Reel does not inspect unrelated browser tabs during setup.")
                .font(.callout).foregroundStyle(.secondary)
        }.fixedSize(horizontal: false, vertical: true)
    }

    private var review: some View {
        VStack(alignment: .leading, spacing: 11) {
            readinessRow("\(setup.selectedCalendarCount) desktop calendars included", ready: setup.calendarAccessAllowed && setup.selectedCalendarCount > 0)
            readinessRow("Screen and system audio checked", ready: setup.screenCaptureVerified)
            readinessRow("Accessibility access", ready: setup.accessibilityAllowed)
            readinessRow("Google Chrome installed", ready: setup.chromeAvailable)
            Text("This also includes meetings from Google Calendar connected through the Reel website, independently of your desktop selection.")
                .font(.callout).foregroundStyle(.secondary)
            Text("Reel must stay open and this Mac awake. Meetings more than five minutes late are skipped. Host admission or sign-in may still require you to act in Chrome.")
                .font(.callout).foregroundStyle(.secondary)
            Text("Automatic recording captures computer sound with the microphone off. Meeting video stays on this Mac. When signed in to Reel, meeting audio is sent securely to OpenAI for transcription and AI notes. You can turn automatic joining off in Meeting calendars at any time.")
                .font(.callout).foregroundStyle(.secondary)
            Toggle("Participants in my selected desktop calendars and any Google Calendar connected in Reel have agreed to automatic recording", isOn: $setup.participantConsent)
                .toggleStyle(.checkbox).fixedSize(horizontal: false, vertical: true)
                .disabled(setup.busy)
            Text("Enable checks access again and saves this consent for your current Reel account, or this Mac when signed out.")
                .font(.caption).foregroundStyle(.secondary)
        }.fixedSize(horizontal: false, vertical: true)
    }

    private func readinessRow(_ title: String, ready: Bool) -> some View {
        Label(title, systemImage: ready ? "checkmark.circle.fill" : "circle")
            .foregroundStyle(ready ? Color.green : Color.secondary)
            .accessibilityLabel("\(title): \(ready ? "ready" : "needs attention")")
    }
}
