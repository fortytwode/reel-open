import AppKit
import ReelCore
import SwiftUI

struct MeetingNotesView: View {
    @ObservedObject var model: AppModel
    let recording: Recording
    private var current: Recording? { model.recordings.first { $0.id == recording.id } }
    private var transcript: String {
        guard let current else { return "Recording removed." }
        return (try? String(contentsOf: model.library.transcriptTextURL(for: current), encoding: .utf8)) ?? "Transcript is not ready yet."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(current?.title ?? "Recording removed").font(.title2)
            Text("Notes are saved in Notion and recaps go to internal calendar invitees, including people who did not attend. Video stays on this Mac.")
                .font(.callout).foregroundStyle(.secondary)
            if let summary = current?.summary { Text(summary).textSelection(.enabled) }
            Divider()
            ScrollView { Text(transcript).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
            Divider()
            if current?.meeting?.needsContentReview == true {
                Text("Needs review. Automatic delivery is paused because the transcript did not provide clear meeting content. Review the recording or transcript, then reprocess if speech was missed.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let receipt = current?.meeting?.deliveryReceipt {
                Text("Verified in Notion; recap delivered to: " + receipt.recipients.joined(separator: ", "))
                    .font(.caption).textSelection(.enabled)
                if let url = URL(string: receipt.url) { Link("Open Notion notes", destination: url) }
            } else if current?.meeting?.needsContentReview == true {
                Text("Recording and transcript saved. No new notes were sent.").font(.caption)
            } else if current?.meeting?.deliveryStatus == nil {
                Text("Older recordings keep their original delivery history. Automatic delivery applies to new meetings.").font(.caption)
            } else if current?.meeting?.deliveryStatus == .noSpeech {
                Text("No speech was detected. The video is saved; notes were not sent.").font(.caption)
            } else if let error = current?.meeting?.deliveryError {
                Text(error).font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Delivery waits for the transcript and AI notes. Failed delivery retries while Reel is open.").font(.caption)
            }
            HStack {
                Button("Show local files") { if let current { NSWorkspace.shared.open(model.library.folder(for: current)) } }
                Spacer()
                if current?.meeting?.needsContentReview == true {
                    Button("Reprocess recording") { if let current { Publisher.shared.transcribeByUser(current) } }
                        .disabled(model.account == nil || current?.transcriptStatus == .pending)
                } else {
                    Button(current?.meeting?.deliveryReceipt == nil ? "Deliver notes / retry" : "Verify delivery again") {
                        if let current { Publisher.shared.deliverMeetingByUser(current) }
                    }.disabled(current?.meeting?.deliveryStatus == nil || current?.meeting?.deliveryStatus == .noSpeech || current?.transcriptStatus != .ready || model.account == nil)
                }
            }
        }.padding(20).frame(width: 700, height: 540)
    }
}

struct MeetingDeliverySettings: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Meeting notes and recaps").font(.headline)
            Text("After a new meeting, Reel automatically saves verified notes in Notion and emails the people in your organization on its calendar invitation. External invitees do not receive the internal recap. Private 1:1, client and sales notes use the shared routing rules.")
                .font(.caption)
            Text("A manual meeting without a calendar invitation is saved in private Calls and emailed only to your signed-in account. Open Meeting notes in Local Recordings to check delivery or retry. Existing recordings are not automatically emailed by this update.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
