import AppKit
import SwiftUI

/// Small HUD near the top-right of the active screen; always visible even if notification
/// permission was never granted.
@MainActor
enum Toast {
    private static var panel: NSPanel?
    private static var hideTask: Task<Void, Never>?
    static var enabled = true

    static func show(_ text: String, isError: Bool = false) {
        print(isError ? "[reel] error: \(text)" : "[reel] \(text)")
        guard enabled else { return }
        let p = panel ?? {
            let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 320, height: 44), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            p.isOpaque = false
            p.backgroundColor = .clear
            p.level = .statusBar
            p.ignoresMouseEvents = true
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            p.isReleasedWhenClosed = false
            panel = p
            return p
        }()
        let view = NSHostingView(rootView: ToastView(text: text, isError: isError))
        let size = view.fittingSize
        p.contentView = view
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let v = screen.visibleFrame
        p.setFrame(NSRect(x: v.maxX - size.width - 16, y: v.maxY - size.height - 12, width: size.width, height: size.height), display: true)
        p.orderFrontRegardless()
        hideTask?.cancel()
        hideTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(isError ? 6 : 3))
            if !Task.isCancelled { p.orderOut(nil) }
        }
    }
}

private struct ToastView: View {
    let text: String
    let isError: Bool
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(isError ? Color.yellow : Color.green)
            Text(text).font(.system(size: 13, weight: .medium)).foregroundStyle(.white).lineLimit(3).frame(maxWidth: 380, alignment: .leading)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.black.opacity(0.85)))
        .fixedSize()
    }
}
