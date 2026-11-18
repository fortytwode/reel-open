import Foundation

/// Output resolution presets (Loom's recorder offers 720p / 1080p / 1440p / 4K).
public enum QualityPreset: String, Codable, CaseIterable, Sendable {
    case p720, p1080, p1440, p2160

    public var label: String {
        switch self {
        case .p720: "720p"
        case .p1080: "1080p"
        case .p1440: "1440p"
        case .p2160: "4K"
        }
    }

    /// Bounding box for the long and short edge.
    public var bounds: (long: Int, short: Int) {
        switch self {
        case .p720: (1280, 720)
        case .p1080: (1920, 1080)
        case .p1440: (2560, 1440)
        case .p2160: (3840, 2160)
        }
    }
}

public struct PixelSize: Equatable, Sendable {
    public var width: Int
    public var height: Int
    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }
}

public enum VideoGeometry {
    /// Fits `source` (pixels) inside the preset box, preserving aspect ratio, never upscaling,
    /// rounded to even dimensions (required by H.264 4:2:0).
    public static func outputSize(source: PixelSize, preset: QualityPreset) -> PixelSize {
        let landscape = source.width >= source.height
        let boxW = Double(landscape ? preset.bounds.long : preset.bounds.short)
        let boxH = Double(landscape ? preset.bounds.short : preset.bounds.long)
        let sw = Double(max(source.width, 2)), sh = Double(max(source.height, 2))
        let scale = min(1, min(boxW / sw, boxH / sh))
        func even(_ v: Double) -> Int { max(2, Int((v / 2).rounded(.down)) * 2) }
        return PixelSize(width: even(sw * scale), height: even(sh * scale))
    }

    /// H.264 average bitrate by pixel-count tier, mirroring Loom's recorder tiers
    /// (360p 0.8, 480p 1.5, 720p 2.5, 1080p 4, 1440p 6, 4K 10 Mbps at 30 fps), ×1.5 above 30 fps.
    public static func bitrate(for size: PixelSize, fps: Int) -> Int {
        let pixels = size.width * size.height
        let base: Int
        switch pixels {
        case ...(640 * 360): base = 800_000
        case ...(854 * 480): base = 1_500_000
        case ...(1280 * 720): base = 2_500_000
        case ...(1920 * 1080): base = 4_000_000
        case ...(2560 * 1440): base = 6_000_000
        default: base = 10_000_000
        }
        return fps > 30 ? base * 3 / 2 : base
    }

    /// Converts the camera bubble's on-screen frame (AppKit global coordinates, origin at the
    /// bottom-left of the primary display) into output-pixel coordinates (origin bottom-left,
    /// as Core Image uses) for a capture of `captureRect` (same global coordinates) rendered at
    /// `output` pixels. Returns nil when the bubble is entirely outside the captured area.
    public static func bubbleRect(bubble: Rect, captureRect: Rect, output: PixelSize) -> Rect? {
        guard captureRect.width > 0, captureRect.height > 0 else { return nil }
        let sx = Double(output.width) / captureRect.width
        let sy = Double(output.height) / captureRect.height
        let r = Rect(x: (bubble.x - captureRect.x) * sx, y: (bubble.y - captureRect.y) * sy,
                     width: bubble.width * sx, height: bubble.height * sy)
        let visible = r.x < Double(output.width) && r.y < Double(output.height) && r.maxX > 0 && r.maxY > 0
        return visible ? r : nil
    }

    /// Maps any rect in AppKit global coordinates into output pixels (origin bottom-left), for a
    /// capture of `captureRect` rendered at `output` (no visibility check).
    public static func map(_ r: Rect, captureRect: Rect, output: PixelSize) -> Rect {
        let sx = Double(output.width) / max(captureRect.width, 1)
        let sy = Double(output.height) / max(captureRect.height, 1)
        return Rect(x: (r.x - captureRect.x) * sx, y: (r.y - captureRect.y) * sy, width: r.width * sx, height: r.height * sy)
    }

    /// Maps a point in AppKit global coordinates into output pixels.
    public static func map(x: Double, y: Double, captureRect: Rect, output: PixelSize) -> (x: Double, y: Double) {
        let r = map(Rect(x: x, y: y, width: 0, height: 0), captureRect: captureRect, output: output)
        return (r.x, r.y)
    }

    /// Area recording: the selection (AppKit global coordinates, bottom-left origin) clipped to
    /// its display and converted to ScreenCaptureKit's `sourceRect` (points, relative to the
    /// display, top-left origin). Returns nil when the selection is too small or off-display.
    /// Loom: "Clipped rect from selection is null" / crop_rect → SCK sourceRect.
    public static func sourceRect(selection: Rect, display: Rect, minimumSide: Double = 32) -> Rect? {
        let x0 = max(selection.x, display.x), y0 = max(selection.y, display.y)
        let x1 = min(selection.maxX, display.maxX), y1 = min(selection.maxY, display.maxY)
        guard x1 - x0 >= minimumSide, y1 - y0 >= minimumSide else { return nil }
        // Whole points keep SCK's crop and the even-pixel output in step.
        let left = (x0 - display.x).rounded(.down), top = (display.maxY - y1).rounded(.down)
        let width = (x1 - x0).rounded(.down), height = (y1 - y0).rounded(.down)
        return Rect(x: left, y: top, width: width, height: height)
    }

    /// The inverse of `sourceRect`: the area actually captured, back in AppKit global coordinates.
    public static func globalRect(sourceRect s: Rect, display: Rect) -> Rect {
        Rect(x: display.x + s.x, y: display.maxY - s.y - s.height, width: s.width, height: s.height)
    }

    /// CoreGraphics global rect (origin top-left of the primary display, y down; e.g. SCWindow.frame)
    /// → AppKit global rect (origin bottom-left of the primary display, y up).
    public static func appKitRect(fromCG r: Rect, primaryHeight: Double) -> Rect {
        Rect(x: r.x, y: primaryHeight - r.y - r.height, width: r.width, height: r.height)
    }

    /// Where the bubble goes when an area is selected and the bubble is outside it: inside the
    /// area's bottom-left corner (AppKit coordinates), shrunk if the area is small.
    public static func bubbleInside(area: Rect, diameter: Double, margin: Double = 24) -> Rect {
        let d = min(diameter, max(48, min(area.width, area.height) * 0.4))
        let m = min(margin, max(0, (min(area.width, area.height) - d) / 2))
        return Rect(x: area.x + m, y: area.y + m, width: d, height: d)
    }

    /// Bubble placement for window recordings: bottom-left corner with a margin, sized as a
    /// fraction of the shorter output edge.
    public static func cornerBubble(output: PixelSize, diameterFraction: Double = 0.22, marginFraction: Double = 0.03) -> Rect {
        let short = Double(min(output.width, output.height))
        let d = (short * diameterFraction).rounded()
        let m = (short * marginFraction).rounded()
        return Rect(x: m, y: m, width: d, height: d)
    }
}

/// Minimal CGRect stand-in so ReelCore stays CoreGraphics-free.
public struct Rect: Codable, Equatable, Sendable {
    public var x: Double, y: Double, width: Double, height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
    public var maxX: Double { x + width }
    public var maxY: Double { y + height }
    public var midX: Double { x + width / 2 }
    public var midY: Double { y + height / 2 }
    public func contains(x px: Double, y py: Double) -> Bool { px >= x && px <= maxX && py >= y && py <= maxY }
    public func intersects(_ o: Rect) -> Bool { x < o.maxX && o.x < maxX && y < o.maxY && o.y < maxY }
}
