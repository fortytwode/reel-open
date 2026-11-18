import AppKit
import ReelCore
import SwiftUI

/// Floating recording controls (excluded from the recording with the rest of Reel's windows).
/// With drawing on, a tool palette (pen, highlighter, arrow, colours, undo, clear) appears.
final class ControlBarWindow: NSPanel {
    static let compact = NSSize(width: 340, height: 48)
    static let expanded = NSSize(width: 340, height: 100)

    init() {
        super.init(contentRect: NSRect(origin: .zero, size: Self.compact), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .floating
        isMovableByWindowBackground = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isReleasedWhenClosed = false
        let host = NSHostingView(rootView: ControlBarView(model: AppModel.shared))
        host.frame = contentRect(forFrameRect: frame)
        host.autoresizingMask = [.width, .height]
        contentView = host
    }

    func present(on screen: NSScreen) {
        let v = screen.visibleFrame
        setFrameOrigin(NSPoint(x: v.midX - frame.width / 2, y: v.minY + 24))
        orderFrontRegardless()
    }

    /// Grows upwards to show the drawing palette, keeping the bar where it is.
    func setExpanded(_ on: Bool) {
        let size = on ? Self.expanded : Self.compact
        guard frame.size != size else { return }
        setFrame(NSRect(origin: frame.origin, size: size), display: true, animate: false)
    }
}

private struct ControlBarView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 6) {
            if model.drawing.isActive { palette }
            bar
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
    }

    private var bar: some View {
        HStack(spacing: 10) {
            TimelineView(.periodic(from: .now, by: 0.5)) { _ in
                HStack(spacing: 6) {
                    Circle().fill(model.phase == .paused ? Color.orange : Color.red).frame(width: 10, height: 10)
                    Text(timeString(RecorderController.shared.elapsed))
                        .font(.system(size: 13, weight: .semibold).monospacedDigit())
                        .foregroundStyle(.white)
                        .frame(minWidth: 44, alignment: .leading)
                }
            }
            Divider().frame(height: 20).overlay(Color.white.opacity(0.2))
            button(model.phase == .paused ? "play.fill" : "pause.fill", help: "Pause / resume (\(model.settings.pauseShortcut.display))") { RecorderController.shared.pauseResume() }
            button("pencil.tip.crop.circle", help: "Draw on screen (\(model.settings.drawShortcut.display))", active: model.drawing.isActive) { RecorderController.shared.toggleDrawing() }
                .disabled(model.settings.mode == .camera)
            button("arrow.counterclockwise", help: "Restart") { RecorderController.shared.restart() }
            button("trash", help: "Cancel (\(model.settings.cancelShortcut.display))") { RecorderController.shared.cancel() }
            Button { RecorderController.shared.stop() } label: {
                HStack(spacing: 5) {
                    RoundedRectangle(cornerRadius: 2).fill(.white).frame(width: 9, height: 9)
                    Text("Stop").font(.system(size: 13, weight: .semibold))
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Capsule().fill(Color(red: 0.91, green: 0.33, blue: 0.24)))
                .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            .help("Stop and share (\(model.settings.shortcut.display))")
        }
        .padding(.horizontal, 14)
        .frame(height: 48)
        .background(Capsule().fill(Color.black.opacity(0.82)))
        .overlay(Capsule().stroke(Color.white.opacity(0.12)))
    }

    private var palette: some View {
        HStack(spacing: 8) {
            ForEach(DrawTool.allCases, id: \.self) { tool in
                button(symbol(for: tool), help: tool.label, active: model.drawing.tool == tool) { RecorderController.shared.setDrawTool(tool) }
            }
            Divider().frame(height: 18).overlay(Color.white.opacity(0.2))
            ForEach(DrawColor.palette, id: \.self) { c in
                Button { RecorderController.shared.setDrawColor(c) } label: {
                    Circle().fill(Color(red: c.r, green: c.g, blue: c.b)).frame(width: 16, height: 16)
                        .overlay(Circle().stroke(Color.white, lineWidth: model.drawing.color == c ? 2 : 0).padding(-3))
                }
                .buttonStyle(.plain)
            }
            Divider().frame(height: 18).overlay(Color.white.opacity(0.2))
            button("arrow.uturn.backward", help: "Undo") { RecorderController.shared.undoDrawing() }
            button("xmark.bin", help: "Clear drawings") { RecorderController.shared.clearDrawing() }
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .background(Capsule().fill(Color.black.opacity(0.82)))
        .overlay(Capsule().stroke(Color.white.opacity(0.12)))
    }

    private func symbol(for tool: DrawTool) -> String {
        switch tool {
        case .pen: "pencil"
        case .highlighter: "highlighter"
        case .arrow: "arrow.up.right"
        }
    }

    private func button(_ symbol: String, help: String, active: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 13, weight: .semibold))
                .foregroundStyle(active ? Color(red: 0.91, green: 0.33, blue: 0.24) : .white)
                .frame(width: 26, height: 26)
                .background(Circle().fill(Color.white.opacity(active ? 0.95 : 0)))
        }
        .buttonStyle(.plain)
        .help(help)
    }

    private func timeString(_ s: Double) -> String {
        let t = Int(s)
        return t >= 3600 ? String(format: "%d:%02d:%02d", t / 3600, (t % 3600) / 60, t % 60) : String(format: "%d:%02d", t / 60, t % 60)
    }
}
