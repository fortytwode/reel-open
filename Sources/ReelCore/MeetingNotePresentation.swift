import Foundation

/// Read-only structure derived from the saved summary.
public struct MeetingNotePresentation: Equatable, Sendable {
    public struct Section: Equatable, Sendable {
        public enum Kind: Equatable, Sendable {
            case outcome, keyPoints, decisions, openQuestions, actionItems
        }

        public let title: String?
        public let kind: Kind?
        public fileprivate(set) var blocks: [Block]
    }

    public enum Block: Equatable, Sendable {
        case paragraph(String)
        case bullet(text: String, depth: Int, marker: String)
    }

    public let source: String
    public let sections: [Section]

    public init(summary: String) {
        source = summary
        var sections: [Section] = []
        var section = Section(title: nil, kind: nil, blocks: [])
        var paragraph: [String] = []
        var listIndents: [Int] = []

        for rawLine in summary.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            let line = String(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let heading = Self.heading(trimmed)
            let bullet = Self.bullet(trimmed)
            if trimmed.isEmpty || heading != nil || bullet != nil {
                if !paragraph.isEmpty {
                    section.blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                    paragraph.removeAll()
                }
            }

            if trimmed.isEmpty {
                continue
            }
            if let heading {
                if section.title != nil || !section.blocks.isEmpty { sections.append(section) }
                section = Section(title: heading.title, kind: heading.kind, blocks: [])
                listIndents.removeAll()
            } else if let bullet {
                let indent = line.prefix(while: { $0 == " " || $0 == "\t" }).reduce(0) { width, character in
                    character == "\t" ? (width / 4 + 1) * 4 : width + 1
                }
                while let last = listIndents.last, last > indent { listIndents.removeLast() }
                if listIndents.last != indent { listIndents.append(indent) }
                section.blocks.append(.bullet(text: bullet.text, depth: listIndents.count - 1, marker: bullet.marker))
            } else {
                paragraph.append(line)
                listIndents.removeAll()
            }
        }
        if !paragraph.isEmpty { section.blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
        if section.title != nil || !section.blocks.isEmpty { sections.append(section) }
        self.sections = sections
    }

    private static func heading(_ line: String) -> (title: String, kind: Section.Kind?)? {
        var title = line
        var explicit = false
        let hashes = title.prefix(while: { $0 == "#" })
        if (1...6).contains(hashes.count), title.dropFirst(hashes.count).first?.isWhitespace == true {
            title = title.dropFirst(hashes.count).trimmingCharacters(in: .whitespaces)
            explicit = true
        }
        if title.hasSuffix(":") { title.removeLast() }
        if title.count > 4, (title.hasPrefix("**") && title.hasSuffix("**") || title.hasPrefix("__") && title.hasSuffix("__")) {
            title = String(title.dropFirst(2).dropLast(2))
            explicit = true
        }
        if title.hasSuffix(":") { title.removeLast() }
        title = title.trimmingCharacters(in: .whitespaces)
        let kind: Section.Kind?
        switch title.lowercased() {
        case "outcome", "summary", "overview", "meeting summary": kind = .outcome
        case "key points", "highlights", "key takeaways", "discussion points": kind = .keyPoints
        case "decisions", "decisions made": kind = .decisions
        case "open questions", "questions", "unresolved questions": kind = .openQuestions
        case "action items", "action item", "actions", "next steps", "follow-ups": kind = .actionItems
        default: kind = nil
        }
        guard !title.isEmpty, explicit || kind != nil else { return nil }
        return (title, kind)
    }

    private static func bullet(_ line: String) -> (text: String, marker: String)? {
        guard let space = line.firstIndex(where: \.isWhitespace) else { return nil }
        let marker = String(line[..<space])
        let number = marker.dropLast()
        let ordered = [".", ")"].contains(marker.last) && !number.isEmpty && number.allSatisfy(\.isNumber)
        guard ordered || ["•", "-", "*", "+", "–", "◦", "▪"].contains(marker) else { return nil }
        return (line[space...].trimmingCharacters(in: .whitespaces), marker)
    }
}
