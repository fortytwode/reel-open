import AppKit

// Command-line verification helpers run without the menu bar UI (see CLI.swift / README).
if let exitCode = CLI.handleImmediate(CommandLine.arguments) {
    exit(exitCode)
}

let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { AppDelegate() }
MainActor.assumeIsolated { delegate.cliRecordTest = CLI.parseRecordTest(CommandLine.arguments) }
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
