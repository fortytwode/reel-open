import XCTest
@testable import ReelCore

final class CaptureFeatureTests: XCTestCase {
    // MARK: Area geometry

    let display = Rect(x: 0, y: 0, width: 1512, height: 982)

    func testSourceRectFlipsToTopLeftDisplayCoordinates() {
        // 400×300 selection whose bottom-left is at (100, 200) in AppKit coordinates.
        let s = VideoGeometry.sourceRect(selection: Rect(x: 100, y: 200, width: 400, height: 300), display: display)
        XCTAssertEqual(s, Rect(x: 100, y: 982 - 500, width: 400, height: 300))
        XCTAssertEqual(VideoGeometry.globalRect(sourceRect: s!, display: display), Rect(x: 100, y: 200, width: 400, height: 300))
    }

    func testSourceRectOnSecondaryDisplayIsRelativeToThatDisplay() {
        let right = Rect(x: 1512, y: -200, width: 1920, height: 1080)
        let s = VideoGeometry.sourceRect(selection: Rect(x: 1612, y: 0, width: 800, height: 600), display: right)
        XCTAssertEqual(s, Rect(x: 100, y: 880 - 600 + 0, width: 800, height: 600))   // top = maxY(880) - 600
    }

    func testSourceRectClipsAndRejectsTinySelections() {
        XCTAssertEqual(VideoGeometry.sourceRect(selection: Rect(x: -50, y: -50, width: 200, height: 200), display: display),
                       Rect(x: 0, y: 982 - 150, width: 150, height: 150))
        XCTAssertNil(VideoGeometry.sourceRect(selection: Rect(x: 10, y: 10, width: 20, height: 400), display: display))
        XCTAssertNil(VideoGeometry.sourceRect(selection: Rect(x: 5000, y: 0, width: 200, height: 200), display: display))
    }

    func testAppKitRectFromCG() {
        XCTAssertEqual(VideoGeometry.appKitRect(fromCG: Rect(x: 10, y: 20, width: 100, height: 50), primaryHeight: 982),
                       Rect(x: 10, y: 912, width: 100, height: 50))
    }

    func testMapIntoOutputPixels() {
        let capture = Rect(x: 100, y: 200, width: 400, height: 300)
        let out = PixelSize(width: 800, height: 600)
        XCTAssertEqual(VideoGeometry.map(Rect(x: 100, y: 200, width: 10, height: 10), captureRect: capture, output: out), Rect(x: 0, y: 0, width: 20, height: 20))
        let p = VideoGeometry.map(x: 300, y: 350, captureRect: capture, output: out)
        XCTAssertEqual(p.x, 400)
        XCTAssertEqual(p.y, 300)
    }

    func testBubbleInsideArea() {
        let r = VideoGeometry.bubbleInside(area: Rect(x: 100, y: 100, width: 800, height: 600), diameter: 220)
        XCTAssertEqual(r, Rect(x: 124, y: 124, width: 220, height: 220))
        let small = VideoGeometry.bubbleInside(area: Rect(x: 0, y: 0, width: 200, height: 150), diameter: 220)
        XCTAssertEqual(small.width, 60)
        XCTAssertLessThanOrEqual(small.maxX, 200)
        XCTAssertLessThanOrEqual(small.maxY, 150)
    }

    // MARK: Drawing

    func testDrawingOffIgnoresMouseAndDropsInput() {
        var d = DrawingState()
        XCTAssertTrue(d.overlayIgnoresMouse)
        d.begin(at: Point(x: 1, y: 1))
        XCTAssertTrue(d.visibleStrokes.isEmpty)
        d.toggle()
        XCTAssertFalse(d.overlayIgnoresMouse)
        d.toggle()
        XCTAssertTrue(d.overlayIgnoresMouse)
    }

    func testPenStrokeLifecycleAndVersioning() {
        var d = DrawingState()
        d.setActive(true)
        let v0 = d.version
        d.begin(at: Point(x: 0, y: 0))
        d.extend(to: Point(x: 10, y: 0))
        d.extend(to: Point(x: 10.2, y: 0.1))   // sub-pixel move ignored
        d.extend(to: Point(x: 20, y: 5))
        XCTAssertEqual(d.visibleStrokes.count, 1)
        XCTAssertEqual(d.visibleStrokes[0].points.count, 3)
        d.end()
        XCTAssertEqual(d.strokes.count, 1)
        XCTAssertGreaterThan(d.version, v0)
        d.undo()
        XCTAssertTrue(d.strokes.isEmpty)
    }

    func testArrowKeepsTwoPointsAndClickWithoutDragIsDropped() {
        var d = DrawingState()
        d.setActive(true)
        d.tool = .arrow
        d.begin(at: Point(x: 0, y: 0))
        d.end()
        XCTAssertTrue(d.strokes.isEmpty)
        d.begin(at: Point(x: 0, y: 0))
        d.extend(to: Point(x: 50, y: 0))
        d.extend(to: Point(x: 100, y: 0))
        d.end()
        XCTAssertEqual(d.strokes.first?.points, [Point(x: 0, y: 0), Point(x: 100, y: 0)])
        let head = d.strokes.first?.arrowHead
        XCTAssertEqual(head?.tip, Point(x: 100, y: 0))
        XCTAssertLessThan(head!.left.x, 100)
        XCTAssertLessThan(head!.left.y, 0)
        XCTAssertGreaterThan(head!.right.y, 0)
    }

    func testClearAndDeactivateFinishesStroke() {
        var d = DrawingState()
        d.setActive(true)
        d.begin(at: Point(x: 0, y: 0))
        d.extend(to: Point(x: 5, y: 5))
        d.setActive(false)
        XCTAssertEqual(d.strokes.count, 1)
        XCTAssertNil(d.current)
        d.clear()
        XCTAssertTrue(d.visibleStrokes.isEmpty)
    }

    func testToolStyles() {
        XCTAssertLessThan(DrawTool.highlighter.alpha, 1)
        XCTAssertGreaterThan(DrawTool.highlighter.width, DrawTool.pen.width)
        XCTAssertNil(ArrowGeometry.head(from: Point(x: 0, y: 0), to: Point(x: 1, y: 0), width: 5))
    }

    func testClickRipple() {
        XCTAssertNil(ClickRipple.appearance(age: -0.1))
        XCTAssertNil(ClickRipple.appearance(age: ClickRipple.duration))
        let a = ClickRipple.appearance(age: 0)!, b = ClickRipple.appearance(age: 0.3)!
        XCTAssertEqual(a.radius, ClickRipple.startRadius)
        XCTAssertGreaterThan(b.radius, a.radius)
        XCTAssertLessThan(b.alpha, a.alpha)
    }

    // MARK: Shortcuts

    func testDefaultsAreDistinctAndValid() {
        let s = ReelSettings()
        let all = ShortcutAction.allCases.map { s.shortcut(for: $0) }
        XCTAssertTrue(all.allSatisfy(\.isValid))
        XCTAssertEqual(Set(all.map { "\($0.keyCode)-\($0.modifiers)" }).count, all.count)
        XCTAssertEqual(Shortcut.toggleDrawing.display, "⌃⌥D")
        for a in ShortcutAction.allCases {
            XCTAssertTrue(ShortcutConflicts.find(s.shortcut(for: a), for: a, assigned: s.shortcuts, system: []).isEmpty, a.rawValue)
        }
    }

    func testSettingsShortcutsDecodeTolerantly() throws {
        let s = try JSONDecoder().decode(ReelSettings.self, from: Data("{\"drawShortcut\":{\"keyCode\":2,\"modifiers\":0,\"key\":\"d\"},\"pauseShortcut\":{\"keyCode\":35,\"modifiers\":\(Shortcut.cmd | Shortcut.shift),\"key\":\"p\"},\"cameraBackground\":\"blur\",\"lastArea\":{\"x\":1,\"y\":2,\"width\":3,\"height\":4}}".utf8))
        XCTAssertEqual(s.drawShortcut, .toggleDrawing)
        XCTAssertEqual(s.pauseShortcut.display, "⇧⌘P")
        XCTAssertEqual(s.cameraBackground, .blur)
        XCTAssertEqual(s.lastArea, Rect(x: 1, y: 2, width: 3, height: 4))
        var t = s
        t.setShortcut(.startStop, for: .toggleDrawing)
        XCTAssertEqual(t.shortcut(for: .toggleDrawing), .startStop)
        XCTAssertTrue(ReelSettings().liveUpload && ReelSettings().uploadMP4 && ReelSettings().aiSummary)
    }

    func testConflictDetection() {
        let s = ReelSettings()
        let dup = ShortcutConflicts.find(.startStop, for: .toggleDrawing, assigned: s.shortcuts, system: [])
        XCTAssertEqual(dup, [.duplicate(.startStop)])
        XCTAssertTrue(dup[0].isBlocking)
        let shot = Shortcut(keyCode: 20, modifiers: Shortcut.cmd | Shortcut.shift, key: "3")
        let sys = [SystemHotKey(keyCode: 20, modifiers: Shortcut.cmd | Shortcut.shift, name: "Save picture of screen as a file")]
        XCTAssertEqual(ShortcutConflicts.find(shot, for: .startStop, assigned: s.shortcuts, system: sys), [.system("Save picture of screen as a file")])
        XCTAssertFalse(ShortcutConflict.system("x").isBlocking)
        let quit = Shortcut(keyCode: 12, modifiers: Shortcut.cmd, key: "q")
        XCTAssertEqual(ShortcutConflicts.find(quit, for: .startStop, assigned: s.shortcuts, system: []), [.common("⌘Q (Quit)")])
    }

    func testParseSymbolicHotKeys() {
        let dict: [String: Any] = [
            "28": ["enabled": true, "value": ["parameters": [51, 20, 1_179_648], "type": "standard"]],     // ⌘⇧3
            "64": ["enabled": false, "value": ["parameters": [32, 49, 1_048_576]]],                        // disabled
            "999": ["enabled": 1, "value": ["parameters": [65535, 65535, 0]]],                              // no key
            "60": ["enabled": true, "value": ["parameters": [32, 49, 262_144]]],                           // ⌃Space
        ]
        let keys = SystemHotKey.parse(symbolicHotKeys: dict)
        XCTAssertEqual(keys.count, 2)
        XCTAssertTrue(keys.contains(SystemHotKey(keyCode: 20, modifiers: Shortcut.cmd | Shortcut.shift, name: "Save picture of screen as a file")))
        XCTAssertTrue(keys.contains(SystemHotKey(keyCode: 49, modifiers: Shortcut.control, name: "Select the previous input source")))
    }

    func testKeyNamesAndEventConversion() {
        XCTAssertEqual(KeyNames.carbonModifiers(cocoa: (1 << 18) | (1 << 19)), Shortcut.control | Shortcut.option)
        XCTAssertEqual(KeyNames.shortcut(keyCode: 15, cocoaFlags: (1 << 18) | (1 << 19)), .startStop)
        XCTAssertNil(KeyNames.shortcut(keyCode: 15, cocoaFlags: 1 << 17))            // shift only
        XCTAssertNil(KeyNames.shortcut(keyCode: 53, cocoaFlags: 1 << 20))            // escape
        XCTAssertEqual(KeyNames.shortcut(keyCode: 122, cocoaFlags: 1 << 20)?.display, "⌘F1")
        XCTAssertEqual(KeyNames.shortcut(keyCode: 49, cocoaFlags: 1 << 18)?.display, "⌃Space")
    }

    // MARK: Summaries

    func transcript(_ segs: [(Double, Double, String)]) -> Transcript {
        Transcript(id: "x", title: "t", language: "en", engine: "e", createdAt: Date(), durationSeconds: segs.last?.1 ?? 0,
                   segments: segs.map { TranscriptSegment(start: $0.0, end: $0.1, text: $0.2) })
    }

    func testFallbackSummaryIsDeterministicAndUsesTheTranscript() {
        let t = transcript([
            (0, 5, "So today I want to walk through the quarterly revenue dashboard."),
            (5, 12, "The revenue dashboard shows churn, trials and revenue by channel."),
            (12, 20, "Um, first let's look at the churn numbers for paid social."),
            (20, 30, "Finally the revenue forecast for next quarter looks strong."),
        ])
        let a = FallbackSummarizer.summarize(t, duration: 30)
        XCTAssertEqual(a, FallbackSummarizer.summarize(t, duration: 30))
        XCTAssertEqual(a.engine, "fallback")
        XCTAssertNotNil(a.title)
        XCTAssertTrue(a.title!.lowercased().contains("revenue"), a.title!)
        XCTAssertFalse(a.title!.lowercased().hasPrefix("so "))
        XCTAssertTrue(a.summary?.contains("revenue") ?? false)
        XCTAssertTrue(a.chapters.isEmpty)   // too short for chapters
    }

    func testFallbackChaptersForLongRecordings() {
        var segs: [(Double, Double, String)] = []
        var t = 0.0
        for i in 0..<60 {
            let gap = (i % 15 == 0 && i > 0) ? 3.0 : 0.2
            t += gap
            segs.append((t, t + 4, "Topic \(i / 15) sentence number \(i) about the plan."))
            t += 4
        }
        let a = FallbackSummarizer.summarize(transcript(segs), duration: t)
        XCTAssertGreaterThanOrEqual(a.chapters.count, 2)
        XCTAssertEqual(a.chapters.first?.start, 0)
        XCTAssertEqual(a.chapters.map(\.start), a.chapters.map(\.start).sorted())
    }

    func testEmptyTranscriptGivesNothing() {
        let a = FallbackSummarizer.summarize(transcript([]), duration: 10)
        XCTAssertNil(a.title)
        XCTAssertNil(a.summary)
    }

    func testValidationCleansModelOutput() {
        let raw = AISummary(title: "  \"**Quarterly revenue review**\"  ", summary: "ok",
                            chapters: [Chapter(start: 50, title: "Second"), Chapter(start: 3, title: "First"), Chapter(start: 55, title: "Too close"),
                                       Chapter(start: 500, title: "Past the end"), Chapter(start: 80, title: "")],
                            engine: "FoundationModels")
        let v = raw.validated(duration: 120)
        XCTAssertEqual(v.title, "Quarterly revenue review")
        XCTAssertNil(v.summary)                                 // too short
        XCTAssertEqual(v.chapters, [Chapter(start: 0, title: "First"), Chapter(start: 50, title: "Second")])
        XCTAssertTrue(FallbackSummarizer.isDefaultTitle("Recording – 21 Oct 2026, 14:03"))
        XCTAssertFalse(FallbackSummarizer.isDefaultTitle("Demo"))
    }

    func testPromptTranscriptCondenses() {
        let segs = (0..<200).map { TranscriptSegment(start: Double($0), end: Double($0) + 1, text: "word word word word word") }
        let p = FallbackSummarizer.promptTranscript(segs, maxChars: 2000)
        XCTAssertLessThanOrEqual(p.count, 2100)
        XCTAssertTrue(p.hasPrefix("[0:00]"))
    }
}
