import Foundation

public struct Point: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public enum DrawTool: String, Codable, CaseIterable, Sendable {
    case pen, highlighter, arrow
    public var label: String {
        switch self {
        case .pen: "Pen"
        case .highlighter: "Highlighter"
        case .arrow: "Arrow"
        }
    }
    /// Stroke width in points (screen space); scaled with the capture in the recording.
    public var width: Double {
        switch self {
        case .pen: 4
        case .highlighter: 20
        case .arrow: 5
        }
    }
    public var alpha: Double { self == .highlighter ? 0.38 : 1 }
}

public struct DrawColor: Codable, Equatable, Hashable, Sendable {
    public var r: Double, g: Double, b: Double
    public init(r: Double, g: Double, b: Double) {
        self.r = r
        self.g = g
        self.b = b
    }
    public static let red = DrawColor(r: 0.95, g: 0.23, b: 0.19)
    public static let yellow = DrawColor(r: 1.0, g: 0.84, b: 0.0)
    public static let green = DrawColor(r: 0.20, g: 0.78, b: 0.35)
    public static let blue = DrawColor(r: 0.0, g: 0.48, b: 1.0)
    public static let white = DrawColor(r: 1, g: 1, b: 1)
    public static let palette: [DrawColor] = [.red, .yellow, .green, .blue, .white]
}

/// One annotation. Points are in AppKit global screen coordinates, so the same stroke can be
/// drawn on the overlay (excluded from capture) and composited into the recording at the
/// matching output pixels.
public struct Stroke: Equatable, Sendable {
    public var tool: DrawTool
    public var color: DrawColor
    public var points: [Point]
    public init(tool: DrawTool, color: DrawColor, points: [Point]) {
        self.tool = tool
        self.color = color
        self.points = points
    }
    public var width: Double { tool.width }
    public var alpha: Double { tool.alpha }

    /// Arrow: shaft from first to last point plus a head (tip, left barb, right barb).
    public var arrowHead: (tip: Point, left: Point, right: Point)? {
        guard tool == .arrow, let a = points.first, let b = points.last else { return nil }
        return ArrowGeometry.head(from: a, to: b, width: width)
    }
}

public enum ArrowGeometry {
    /// Barbs at ±28° from the shaft, length proportional to the stroke width (and at most
    /// 40 % of the shaft so short arrows stay arrows).
    public static func head(from a: Point, to b: Point, width: Double) -> (tip: Point, left: Point, right: Point)? {
        let dx = b.x - a.x, dy = b.y - a.y
        let len = (dx * dx + dy * dy).squareRoot()
        guard len >= 2 else { return nil }
        let headLen = min(max(14, width * 4), len * 0.4)
        let angle = atan2(dy, dx)
        let spread = 28.0 * .pi / 180
        func barb(_ s: Double) -> Point {
            Point(x: b.x - headLen * cos(angle + s), y: b.y - headLen * sin(angle + s))
        }
        return (b, barb(spread), barb(-spread))
    }
}

/// Drawing mode state shared by the overlay window and the compositor. When drawing is off the
/// overlay must ignore mouse events so clicks reach the apps underneath.
public struct DrawingState: Equatable, Sendable {
    public private(set) var isActive = false
    public var tool: DrawTool = .pen
    public var color: DrawColor = .red
    public private(set) var strokes: [Stroke] = []
    public private(set) var current: Stroke?
    /// Bumped on every visible change; renderers cache by it.
    public private(set) var version = 0

    public init() {}

    /// The overlay intercepts clicks only while drawing.
    public var overlayIgnoresMouse: Bool { !isActive }

    /// Everything that should be visible (finished strokes plus the one being drawn).
    public var visibleStrokes: [Stroke] { current.map { strokes + [$0] } ?? strokes }

    public mutating func setActive(_ on: Bool) {
        guard on != isActive else { return }
        isActive = on
        if !on, current != nil { end() }
        version += 1
    }

    public mutating func toggle() { setActive(!isActive) }

    public mutating func begin(at p: Point) {
        guard isActive else { return }
        current = Stroke(tool: tool, color: color, points: [p])
        version += 1
    }

    public mutating func extend(to p: Point) {
        guard var c = current else { return }
        if c.tool == .arrow {
            c.points = [c.points[0], p]
        } else {
            if let last = c.points.last, abs(last.x - p.x) < 0.5, abs(last.y - p.y) < 0.5 { return }
            c.points.append(p)
        }
        current = c
        version += 1
    }

    public mutating func end() {
        guard let c = current else { return }
        current = nil
        // A click without a drag leaves a dot for pens, nothing for arrows.
        if c.tool != .arrow || c.points.count >= 2 { strokes.append(c) }
        version += 1
    }

    public mutating func undo() {
        guard !strokes.isEmpty else { return }
        strokes.removeLast()
        version += 1
    }

    public mutating func clear() {
        guard !strokes.isEmpty || current != nil else { return }
        strokes = []
        current = nil
        version += 1
    }

    /// Programmatic stroke (CLI verification).
    public mutating func add(_ stroke: Stroke) {
        strokes.append(stroke)
        version += 1
    }
}

/// Loom-style click highlight: an expanding, fading ring at each mouse-down, composited into
/// the recording (Reel's own windows are ignored, like Loom's window_ids_to_ignore_clicks).
public enum ClickRipple {
    public static let duration = 0.5
    public static let startRadius = 10.0   // points
    public static let endRadius = 30.0

    /// Ring radius (points) and opacity `age` seconds after the click; nil once finished.
    public static func appearance(age: Double) -> (radius: Double, alpha: Double)? {
        guard age >= 0, age < duration else { return nil }
        let p = age / duration
        let eased = 1 - (1 - p) * (1 - p)
        return (startRadius + (endRadius - startRadius) * eased, 0.85 * (1 - p))
    }
}

public struct ClickEvent: Equatable, Sendable {
    public var x: Double
    public var y: Double
    /// Host-clock seconds.
    public var time: Double
    public init(x: Double, y: Double, time: Double) {
        self.x = x
        self.y = y
        self.time = time
    }
}
