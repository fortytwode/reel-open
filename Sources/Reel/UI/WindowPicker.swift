import AppKit
import ScreenCaptureKit
import SwiftUI

/// Lists real app windows, including titled windows on other Spaces, without exposing
/// hidden untitled helpers such as Chrome's background surfaces and AutoFill.
@MainActor
enum WindowPicker {
    struct Item: Identifiable {
        let id: CGWindowID
        let window: SCWindow
        let app: String
        let title: String
        let icon: NSImage?
    }

    static func candidates(_ content: SCShareableContent) -> [Item] {
        let me = ProcessInfo.processInfo.processIdentifier
        let items: [Item] = content.windows.compactMap { w in
            guard w.windowLayer == 0, w.frame.width >= 160, w.frame.height >= 100,
                  let app = w.owningApplication, app.processID != me,
                  let running = NSRunningApplication(processIdentifier: app.processID) else { return nil }
            let title = (w.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            // A normal untitled window can be useful while visible. Hidden untitled
            // surfaces are commonly app helpers, not documents the user can identify.
            guard w.isOnScreen || !title.isEmpty else { return nil }
            let name = app.applicationName.isEmpty ? app.bundleIdentifier : app.applicationName
            return Item(id: w.windowID, window: w, app: name, title: title, icon: running.icon)
        }
        return items.sorted { lhs, rhs in
            if lhs.window.isOnScreen != rhs.window.isOnScreen { return lhs.window.isOnScreen }
            let appOrder = lhs.app.localizedStandardCompare(rhs.app)
            if appOrder != .orderedSame { return appOrder == .orderedAscending }
            let titleOrder = lhs.title.localizedStandardCompare(rhs.title)
            if titleOrder != .orderedSame { return titleOrder == .orderedAscending }
            return lhs.id < rhs.id
        }
    }

    static func pick(from content: SCShareableContent) async -> SCWindow? {
        await pick(items: candidates(content))
    }

    static func pick(items: [Item]) async -> SCWindow? {
        guard !items.isEmpty else { return nil }
        return await withCheckedContinuation { (c: CheckedContinuation<SCWindow?, Never>) in
            let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 500), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            panel.title = "Choose a window to record"
            panel.isReleasedWhenClosed = false
            panel.level = .floating
            var finished = false
            let finish: (SCWindow?) -> Void = { w in
                guard !finished else { return }
                finished = true
                panel.close()
                c.resume(returning: w)
            }
            panel.contentView = NSHostingView(rootView: PickerView(items: items, choose: finish))
            let delegate = PanelCloseDelegate { finish(nil) }
            panel.delegate = delegate
            objc_setAssociatedObject(panel, "delegate", delegate, .OBJC_ASSOCIATION_RETAIN)
            panel.center()
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        }
    }

    private struct PickerView: View {
        let items: [Item]
        let choose: (SCWindow?) -> Void
        var body: some View {
            VStack(spacing: 0) {
                Text("Choose the window showing the tab you want. The whole window is recorded, including tabs you switch to.")
                    .font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                List(items) { item in
                    Button { choose(item.window) } label: {
                        WindowRow(item: item)
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 4)
                }
                HStack {
                    Spacer()
                    Button("Cancel") { choose(nil) }.keyboardShortcut(.cancelAction)
                }
                .padding(12)
            }
        }
    }

    private struct WindowRow: View {
        let item: Item
        @State private var preview: NSImage?

        var body: some View {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 6).fill(.quaternary)
                    if let preview {
                        Image(nsImage: preview).resizable().scaledToFit()
                    } else if let icon = item.icon {
                        Image(nsImage: icon).resizable().scaledToFit().padding(12)
                    }
                }
                .frame(width: 96, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title.isEmpty ? "Untitled window" : item.title)
                        .font(.headline).lineLimit(2)
                    Text(item.app).font(.caption).foregroundStyle(.secondary)
                    Text("\(Int(item.window.frame.width))×\(Int(item.window.frame.height))\(item.window.isOnScreen ? "" : " · Not on current desktop")")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .task(id: item.id) {
                let config = SCStreamConfiguration()
                config.width = 192
                config.height = 120
                config.showsCursor = false
                config.scalesToFit = true
                config.preservesAspectRatio = true
                guard let image = try? await SCScreenshotManager.captureImage(
                    contentFilter: SCContentFilter(desktopIndependentWindow: item.window), configuration: config),
                    !Task.isCancelled else { return }
                preview = NSImage(cgImage: image, size: .zero)
            }
        }
    }
}

final class PanelCloseDelegate: NSObject, NSWindowDelegate {
    let onClose: () -> Void
    init(onClose: @escaping () -> Void) { self.onClose = onClose }
    func windowWillClose(_ notification: Notification) { onClose() }
}
