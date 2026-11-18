import CoreGraphics
import CoreImage
import ReelCore

/// Rasterises annotations and click ripples for the compositor. Strokes are vector data in
/// screen coordinates (shared with the on-screen drawing overlay, which itself is excluded from
/// capture) and are drawn at output resolution, cached until the drawing changes.
final class OverlayRenderer {
    private var cachedVersion = -1
    private var cachedKey = ""
    private var cached: CIImage?

    /// `map` converts AppKit global points to output pixels; `scale` is output pixels per point.
    func strokes(_ state: DrawingState, size: PixelSize, scale: CGFloat, map: (Point) -> CGPoint) -> CIImage? {
        let visible = state.visibleStrokes
        let key = "\(size.width)x\(size.height)@\(scale)"
        if state.version == cachedVersion, key == cachedKey { return cached }
        cachedVersion = state.version
        cachedKey = key
        guard !visible.isEmpty else { cached = nil; return nil }
        guard let ctx = CGContext(data: nil, width: size.width, height: size.height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        for stroke in visible { Self.draw(stroke, in: ctx, scale: scale, map: map) }
        cached = ctx.makeImage().map { CIImage(cgImage: $0) }
        return cached
    }

    static func draw(_ stroke: Stroke, in ctx: CGContext, scale: CGFloat, map: (Point) -> CGPoint) {
        let color = CGColor(srgbRed: stroke.color.r, green: stroke.color.g, blue: stroke.color.b, alpha: stroke.alpha)
        ctx.saveGState()
        ctx.setStrokeColor(color)
        ctx.setFillColor(color)
        ctx.setLineWidth(CGFloat(stroke.width) * scale)
        ctx.setLineCap(stroke.tool == .highlighter ? .square : .round)
        ctx.setLineJoin(.round)
        let pts = stroke.points.map(map)
        if pts.count == 1 {
            let r = CGFloat(stroke.width) * scale / 2
            ctx.fillEllipse(in: CGRect(x: pts[0].x - r, y: pts[0].y - r, width: 2 * r, height: 2 * r))
        } else if let first = pts.first {
            if stroke.tool == .arrow, let head = stroke.arrowHead {
                // Stop the shaft inside the head so the tip stays sharp.
                let tip = map(head.tip), l = map(head.left), r = map(head.right)
                let base = CGPoint(x: (l.x + r.x) / 2, y: (l.y + r.y) / 2)
                ctx.move(to: first)
                ctx.addLine(to: base)
                ctx.strokePath()
                ctx.move(to: tip)
                ctx.addLine(to: l)
                ctx.addLine(to: r)
                ctx.closePath()
                ctx.fillPath()
            } else {
                ctx.move(to: first)
                for p in pts.dropFirst() { ctx.addLine(to: p) }
                ctx.strokePath()
            }
        }
        ctx.restoreGState()
    }

    /// One ripple ring centred at `center` (output pixels).
    static func ring(center: CGPoint, radius: CGFloat, alpha: CGFloat, lineWidth: CGFloat) -> CIImage? {
        let side = Int((radius + lineWidth) * 2 + 4)
        guard side > 2, let ctx = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
                                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let c = CGFloat(side) / 2
        ctx.setFillColor(CGColor(srgbRed: 1.0, green: 0.78, blue: 0.0, alpha: alpha * 0.25))
        ctx.fillEllipse(in: CGRect(x: c - radius, y: c - radius, width: radius * 2, height: radius * 2))
        ctx.setStrokeColor(CGColor(srgbRed: 1.0, green: 0.62, blue: 0.0, alpha: alpha))
        ctx.setLineWidth(lineWidth)
        ctx.strokeEllipse(in: CGRect(x: c - radius, y: c - radius, width: radius * 2, height: radius * 2))
        guard let img = ctx.makeImage() else { return nil }
        return CIImage(cgImage: img).transformed(by: CGAffineTransform(translationX: center.x - c, y: center.y - c))
    }
}
