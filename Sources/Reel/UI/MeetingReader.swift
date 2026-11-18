import AppKit
import ReelCore
import SwiftUI

/// Shared shell for the local and cloud readers. Content and copy always use the signed-in meeting.
struct MeetingReader<Content: View>: View {
    let title: String
    let date: Date
    let duration: String
    let recipients: [String]
    let libraryURL: URL?
    let copyText: String?
    @Binding var transcriptSelected: Bool
    @Binding var focused: Bool
    @ViewBuilder let content: () -> Content

    @State private var audienceShown = false
    @State private var copied = false
    @State private var copyReset: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            header
                .frame(maxWidth: 680, alignment: .leading)
                .padding(.horizontal, 30)
                .frame(maxWidth: .infinity)
                .padding(.top, 20)
                .padding(.bottom, 14)
            Divider()
            ScrollView {
                content()
                    .frame(maxWidth: 680, alignment: .leading)
                    .padding(.horizontal, 30)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 26)
                    .padding(.bottom, 40)
            }
            .id(transcriptSelected)
        }
        .background(Color(nsColor: .textBackgroundColor))
        .onChange(of: transcriptSelected) { _, _ in resetCopy() }
        .onDisappear { resetCopy() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Group {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                    Text("·").accessibilityHidden(true)
                    Text(duration).monospacedDigit()
                }.font(.callout).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Button {
                    focused.toggle()
                } label: {
                    Label(focused ? "Show meetings" : "Expand reading view",
                          systemImage: focused ? "rectangle.leadinghalf.inset.filled" : "arrow.up.left.and.arrow.down.right")
                        .labelStyle(.iconOnly)
                }
                .help(focused ? "Show meetings" : "Expand reading view")
            }

            Text(title)
                .font(.system(.largeTitle, design: .serif).weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityAddTraits(.isHeader)

            HStack(spacing: 8) {
                if !recipients.isEmpty {
                    Button {
                        audienceShown.toggle()
                    } label: {
                        Label("Shared with \(recipients.count)", systemImage: "person.2")
                    }
                    .popover(isPresented: $audienceShown, arrowEdge: .bottom) {
                        audience.padding(16).frame(width: 300)
                    }
                }
                if let libraryURL {
                    Link(destination: libraryURL) {
                        Label("Open in library", systemImage: "arrow.up.right")
                    }
                }
            }.font(.callout)

            HStack(spacing: 12) {
                Picker("Notes", selection: $transcriptSelected) {
                    Text("Summary").tag(false)
                    Text("Transcript").tag(true)
                }
                .labelsHidden().pickerStyle(.segmented).fixedSize()
                Spacer()
                Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "document.on.document",
                       action: copy)
                    .disabled(copyText?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false)
                    .accessibilityLabel(transcriptSelected ? "Copy transcript" : "Copy summary")
            }
        }
    }

    private var audience: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Notes shared with").font(.headline).accessibilityAddTraits(.isHeader)
            ScrollView {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(recipients, id: \.self) { email in
                        Text(email).font(.callout).textSelection(.enabled)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 220)
            Text("Only the listed recipients can open these notes.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func copy() {
        guard let copyText, !copyText.isEmpty else { return }
        resetCopy()
        NSPasteboard.general.clearContents()
        copied = NSPasteboard.general.setString(copyText, forType: .string)
        copyReset = Task {
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { copied = false }
        }
    }

    private func resetCopy() {
        copyReset?.cancel()
        copied = false
    }
}

struct MeetingSummaryContent: View {
    let summary: String

    var body: some View {
        let presentation = MeetingNotePresentation(summary: summary)
        if presentation.sections.isEmpty {
            ContentUnavailableView("No summary available", systemImage: "text.document")
        } else {
            VStack(alignment: .leading, spacing: 25) {
                ForEach(Array(presentation.sections.enumerated()), id: \.offset) { _, section in
                    sectionView(section)
                }
            }.textSelection(.enabled)
        }
    }

    private func sectionView(_ section: MeetingNotePresentation.Section) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            if let title = section.title {
                Text(title)
                    .font(.system(size: 17, weight: .semibold))
                    .accessibilityAddTraits(.isHeader)
            }
            ForEach(Array(section.blocks.enumerated()), id: \.offset) { index, block in
                if section.kind == .actionItems, index > 0 { Divider() }
                blockView(block, emphasizeLead: section.kind == .keyPoints || section.kind == .actionItems)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(section.kind == .outcome || section.kind == .actionItems ? 16 : 0)
        .background(section.kind == .outcome ? Color.accentColor.opacity(0.08)
                    : section.kind == .actionItems ? Color.primary.opacity(0.035) : .clear,
                    in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private func blockView(_ block: MeetingNotePresentation.Block, emphasizeLead: Bool) -> some View {
        switch block {
        case .paragraph(let text):
            Text(text).meetingReaderBody()
        case .bullet(let text, let depth, let marker):
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Text(marker).font(.system(size: 14, weight: .semibold)).foregroundStyle(.tint)
                    .accessibilityHidden(marker == "•" || marker == "-" || marker == "*")
                emphasized(text, enabled: emphasizeLead).meetingReaderBody()
            }
            .padding(.leading, CGFloat(min(max(depth, 0), 3)) * 14)
        }
    }

    private func emphasized(_ text: String, enabled: Bool) -> Text {
        var formatted = AttributedString(text)
        if enabled, let colon = text.firstIndex(of: ":"), text.distance(from: text.startIndex, to: colon) < 82 {
            if let label = formatted.range(of: String(text[...colon])) {
                formatted[label].inlinePresentationIntent = .stronglyEmphasized
            }
        }
        return Text(formatted)
    }
}

struct MeetingTranscriptContent: View {
    let note: SharedMeetingNote
    private let speakerColors: [Color] = [.teal, .indigo, .blue, .purple, .orange]

    var body: some View {
        if note.transcriptSegments.isEmpty {
            Text(note.transcriptText ?? "").meetingReaderBody().textSelection(.enabled)
        } else {
            let attributed = note.transcriptAttribution != nil || note.transcriptSegments.contains { $0.speakerName != nil }
            LazyVStack(alignment: .leading, spacing: 0) {
                if let notice = note.transcriptAttribution?.notice {
                    Label(notice, systemImage: "info.circle")
                        .font(.callout).foregroundStyle(.secondary)
                        .padding(.bottom, 17)
                } else if note.transcriptSegments.contains(where: { $0.approximateTimestamp != nil }) {
                    Text("Transcript timestamps are approximate.")
                        .font(.callout).foregroundStyle(.secondary).padding(.bottom, 17)
                }
                ForEach(Array(note.transcriptSegments.enumerated()), id: \.offset) { index, segment in
                    if index > 0 { Divider() }
                    turn(segment, showSpeaker: attributed)
                }
            }.textSelection(.enabled)
        }
    }

    private func turn(_ segment: SharedMeetingTranscriptSegment, showSpeaker: Bool) -> some View {
        HStack(alignment: .top, spacing: 13) {
            if showSpeaker {
                RoundedRectangle(cornerRadius: 2)
                    .fill(speakerColor(segment.speakerName))
                    .frame(width: 3, height: 17)
                    .padding(.top, 2)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 7) {
                if showSpeaker || segment.approximateTimestamp != nil {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        if showSpeaker {
                            Text(segment.speakerName ?? "Speaker unknown")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(segment.speakerName == nil ? .secondary : .primary)
                        }
                        Spacer()
                        if let timestamp = segment.approximateTimestamp {
                            Text(timestamp)
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                .accessibilityLabel("Approximate time \(timestamp)")
                        }
                    }
                }
                Text(segment.text).meetingReaderBody()
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.padding(.vertical, 13)
    }

    private func speakerColor(_ name: String?) -> Color {
        guard let name else { return .secondary.opacity(0.4) }
        let index = name.utf8.reduce(0) { ($0 * 31 + Int($1)) % speakerColors.count }
        return speakerColors[index]
    }
}

extension View {
    fileprivate func meetingReaderBody() -> some View {
        font(.system(size: 15)).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
    }
}
