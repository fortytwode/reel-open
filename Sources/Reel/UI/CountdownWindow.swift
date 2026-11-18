import AppKit
import SwiftUI

final class CountdownWindow: NSPanel {
    private let label = NSHostingView(rootView: CountdownView(number: 3))

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 180, height: 180), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        level = .screenSaver
        ignoresMouseEvents = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isReleasedWhenClosed = false
        contentView = label
    }

    func show(number: Int, on screen: NSScreen) {
        label.rootView = CountdownView(number: number)
        let f = screen.frame
        setFrameOrigin(NSPoint(x: f.midX - 90, y: f.midY - 90))
        orderFrontRegardless()
    }
}

private struct CountdownView: View {
    let number: Int
    var body: some View {
        ZStack {
            Circle().fill(Color.black.opacity(0.72))
            Text("\(number)").font(.system(size: 88, weight: .bold, design: .rounded)).foregroundStyle(.white)
        }
        .frame(width: 180, height: 180)
    }
}
