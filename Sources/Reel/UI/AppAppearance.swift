import AppKit
import SwiftUI

enum ReelPanelPalette {
    static let ink = Color(red: 18 / 255, green: 21 / 255, blue: 26 / 255)
    static let mint = Color(red: 114 / 255, green: 231 / 255, blue: 212 / 255)

    static func accentText(in scheme: ColorScheme) -> Color {
        scheme == .dark ? mint : Color(red: 14 / 255, green: 101 / 255, blue: 87 / 255)
    }
}

struct ReelProminentButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(isEnabled ? ReelPanelPalette.ink : Color.secondary)
            .padding(.horizontal, 11)
            .padding(.vertical, 5)
            .background(
                isEnabled ? ReelPanelPalette.mint.opacity(configuration.isPressed ? 0.78 : 1)
                    : Color.secondary.opacity(0.12),
                in: RoundedRectangle(cornerRadius: 6)
            )
    }
}

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
