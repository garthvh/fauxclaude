// Ollama Claude Shim — macOS menu bar app (SwiftUI).
// Owns the Node shim process: start/stop, mode toggle, dashboard, and a
// one-click Claude Code terminal pointed at the shim.
import SwiftUI
import AppKit

// MARK: - Shim process controller

final class ShimController: ObservableObject {
    static let shared = ShimController()

    let port = 11435
    var shimURL: String { "http://127.0.0.1:\(port)" }

    @Published var running = false
    @Published var mode = "…"
    @Published var ollamaStatus = "checking…"
    @Published var mockMode = UserDefaults.standard.bool(forKey: "mockMode") {
        didSet {
            UserDefaults.standard.set(mockMode, forKey: "mockMode")
            guard process != nil else { return }
            stopProcess()  // restart in the new mode
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.start() }
        }
    }

    private var process: Process?
    private var timer: Timer?

    var logURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/ollama-claude-shim.log")
    }

    private init() {
        start()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            self?.poll()
        }
        poll()
    }

    // MARK: process lifecycle

    private func findNode() -> String? {
        for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        let probe = Process()
        probe.executableURL = URL(fileURLWithPath: "/bin/zsh")
        probe.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        probe.standardOutput = pipe
        try? probe.run()
        probe.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return out.isEmpty ? nil : out
    }

    func start() {
        guard process == nil else { return }
        guard let node = findNode() else {
            alert("Node.js not found", "The shim needs Node 18+. Install it with:\n\nbrew install node")
            return
        }
        guard let serverJS = Bundle.main.path(forResource: "server", ofType: "mjs") else {
            alert("Bundle broken", "server.mjs missing from app Resources.")
            return
        }
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let log = try? FileHandle(forWritingTo: logURL)
        log?.seekToEndOfFile()

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [serverJS]
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port)
        env["MOCK"] = mockMode ? "1" : "0"
        p.environment = env
        p.standardOutput = log
        p.standardError = log
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.process = nil
                self?.poll()
            }
        }
        do {
            try p.run()
            process = p
        } catch {
            alert("Failed to start shim", error.localizedDescription)
        }
    }

    func stopProcess() {
        process?.terminate()
        process = nil
    }

    func toggle() {
        if process != nil || running { stopProcess() } else { start() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.poll() }
    }

    // MARK: actions

    func openDashboard() {
        NSWorkspace.shared.open(URL(string: "\(shimURL)/")!)
    }

    func runClaude() {
        if process == nil && !running { start() }
        // No credential env vars: Claude Code's existing claude.ai login rides
        // through to the shim (which ignores auth). Setting ANTHROPIC_API_KEY or
        // ANTHROPIC_AUTH_TOKEN alongside a claude.ai login triggers Claude Code's
        // auth-conflict warning, so unset both defensively.
        let cmd = "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; " +
                  "export ANTHROPIC_BASE_URL=\(shimURL); " +
                  "export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1; claude"
        let script = """
        tell application "Terminal"
            activate
            do script "\(cmd)"
        end tell
        """
        var err: NSDictionary?
        NSAppleScript(source: script)?.executeAndReturnError(&err)
        if err != nil {
            alert("Couldn't open Terminal",
                  "Grant automation permission in System Settings → Privacy & Security → Automation, or run manually:\n\n\(cmd)")
        }
    }

    func openLog() {
        NSWorkspace.shared.open(logURL)
    }

    // MARK: health polling

    private func poll() {
        var req = URLRequest(url: URL(string: "\(shimURL)/health")!)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let self else { return }
            var up = false
            var mode = "?"
            if let data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               json["ok"] as? Bool == true {
                up = true
                mode = json["mode"] as? String ?? "?"
            }
            DispatchQueue.main.async {
                self.running = up
                self.mode = mode
            }
            self.pollOllama()
        }.resume()
    }

    private func pollOllama() {
        if mockMode {
            DispatchQueue.main.async { self.ollamaStatus = "not needed (mock mode)" }
            return
        }
        var req = URLRequest(url: URL(string: "http://127.0.0.1:11434/api/tags")!)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            var status = "not running — start with `ollama serve`"
            if let data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let models = json["models"] as? [[String: Any]] {
                status = "running (\(models.count) model\(models.count == 1 ? "" : "s"))"
            }
            DispatchQueue.main.async { self?.ollamaStatus = status }
        }.resume()
    }

    private func alert(_ title: String, _ text: String) {
        DispatchQueue.main.async {
            let a = NSAlert()
            a.messageText = title
            a.informativeText = text
            a.runModal()
        }
    }
}

// MARK: - Menu UI

struct MenuContent: View {
    @ObservedObject var shim: ShimController

    var body: some View {
        Text(shim.running ? "Shim: running (\(shim.mode)) on :\(shim.port)" : "Shim: stopped")
        Text("Ollama: \(shim.ollamaStatus)")
        Divider()
        Button(shim.running ? "Stop Shim" : "Start Shim") { shim.toggle() }
            .keyboardShortcut("s")
        Toggle("Mock Mode (no Ollama, canned replies)", isOn: $shim.mockMode)
        Divider()
        Button("Open Dashboard") { shim.openDashboard() }
            .keyboardShortcut("d")
        Button("Run Claude Code in Terminal") { shim.runClaude() }
            .keyboardShortcut("t")
        Button("View Shim Log") { shim.openLog() }
        Divider()
        Button("Quit (stops shim)") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillTerminate(_ notification: Notification) {
        ShimController.shared.stopProcess()
    }
}

@main
struct OllamaClaudeShimApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var shim = ShimController.shared

    var body: some Scene {
        MenuBarExtra {
            MenuContent(shim: shim)
        } label: {
            Image(systemName: shim.running ? "bolt.horizontal.circle.fill" : "bolt.horizontal.circle")
        }
    }
}
