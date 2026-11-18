import AppKit
import SwiftUI

@MainActor
final class ReelAppearance: ObservableObject {
    enum Mode: String, CaseIterable {
        case system = "System"
        case light = "Light"
        case dark = "Dark"
    }

    static let shared = ReelAppearance()
    private static let defaultsKey = "ReelAppearance"

    @Published var mode: Mode {
        didSet {
            UserDefaults.standard.set(mode.rawValue, forKey: Self.defaultsKey)
            apply()
        }
    }

    private init() {
        mode = UserDefaults.standard.string(forKey: Self.defaultsKey)
            .flatMap(Mode.init(rawValue:)) ?? .system
    }

    func apply() {
        switch mode {
        case .system: NSApp.appearance = nil
        case .light: NSApp.appearance = NSAppearance(named: .aqua)
        case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
        }
    }
}

struct ReelAppearancePicker: View {
    @ObservedObject private var appearance = ReelAppearance.shared

    var body: some View {
        Picker("Appearance", selection: $appearance.mode) {
            ForEach(ReelAppearance.Mode.allCases, id: \.self) { mode in
                Text(mode.rawValue).tag(mode)
            }
        }
    }
}

struct ReelAppearanceMenu: View {
    var body: some View {
        Menu {
            ReelAppearancePicker()
        } label: {
            Label("Appearance", systemImage: "circle.lefthalf.filled")
                .labelStyle(.iconOnly)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .help("Appearance")
    }
}
