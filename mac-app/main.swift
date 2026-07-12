// FauxClaude — 100% locally sourced Claude. macOS menu bar app (SwiftUI).
// Owns the FauxClaude server process: start/stop, mode toggle, dashboard, and a
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

    // OLLAMA_NUM_PARALLEL: 1 = interactive (one KV slot, so the prompt prefix stays
    // cached and turn 2+ are fast); higher = simulation/load testing (parallel
    // slots, but each turn re-prefills the whole prompt). Read from the live env.
    @Published var parallel: Int = ShimController.readParallel() {
        didSet {
            guard oldValue != parallel else { return }
            applyParallel(parallel)
        }
    }

    private var process: Process?
    private var timer: Timer?

    var logURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/fauxclaude.log")
    }
    // Reused VS Code profile for the local instance — stable so it isn't a blank
    // session each time (remembers recents/layout); kept out of any project folder.
    var vscodeProfileURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/FauxClaude/vscode-profile")
    }
    var modelMapURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".fauxclaude-model-map.json")
    }
    private let parallelAgentLabel = "com.garthvh.fauxclaude.ollama-parallel"
    private var parallelAgentURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(parallelAgentLabel).plist")
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
            alert("Node.js not found", "FauxClaude needs Node 18+. Install it with:\n\nbrew install node")
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
        // Per-Claude-model routing comes from a persistent, user-editable file
        // (Edit Model Map… in the menu). The shim reads it and falls back to its
        // built-in fast-Haiku default when the file is absent. Opus/Sonnet default
        // to the larger quality model; both fall back if a model isn't installed.
        if env["MODEL_MAP"] == nil { env["MODEL_MAP_FILE"] = modelMapURL.path }
        if env["OLLAMA_MODEL"] == nil { env["OLLAMA_MODEL"] = "qwen3-vl:30b-a3b-instruct" }
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
            alert("Failed to start FauxClaude", error.localizedDescription)
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
        // Launch Claude Code with its own model and thinking settings (no --model,
        // no MAX_THINKING_TOKENS); the shim routes each tier per the model map.
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

    // Open a chosen PROJECT in VS Code pointed at the shim. Claude Code (CLI or the
    // VS Code extension) reads ANTHROPIC_BASE_URL from its PROCESS environment —
    // settings.json can't redirect it — so we launch VS Code with the env set. A
    // dedicated (reused) --user-data-dir keeps this a separate, isolated instance
    // that inherits the env even if your normal VS Code is open, and stays pointed
    // local across projects. Extensions are shared from the default location; the
    // shim ignores auth, so a dummy token stands in for the login.
    func openVSCode() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Open in FauxClaude"
        panel.message = "Choose a project folder to open in VS Code pointed at your local shim."
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let folder = panel.url else { return }

        installStatusExtension()  // keep the status-bar llama present & up to date

        let vscode = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"
        guard FileManager.default.isExecutableFile(atPath: vscode) else {
            alert("VS Code not found",
                  "Install VS Code in /Applications. Or open \(folder.path) manually with ANTHROPIC_BASE_URL=\(shimURL) set.")
            return
        }
        let profile = vscodeProfileURL
        try? FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: vscode)
        p.arguments = [folder.path, "--user-data-dir", profile.path]
        var env = ProcessInfo.processInfo.environment
        env.removeValue(forKey: "ANTHROPIC_API_KEY")
        env["ANTHROPIC_BASE_URL"] = shimURL
        env["ANTHROPIC_AUTH_TOKEN"] = "local"          // shim ignores auth; satisfies the client
        env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
        p.environment = env
        do { try p.run() } catch {
            alert("Couldn't open VS Code", error.localizedDescription)
        }
    }

    // Copy the bundled FauxClaude Status extension into VS Code's shared extensions
    // dir (refreshing it), so the local window always shows the status-bar llama.
    // Best-effort; a running VS Code picks it up on its next start.
    private func installStatusExtension() {
        let fm = FileManager.default
        guard let src = Bundle.main.resourceURL?.appendingPathComponent("vscode-extension"),
              fm.fileExists(atPath: src.path) else { return }
        let dest = fm.homeDirectoryForCurrentUser
            .appendingPathComponent(".vscode/extensions/garthvh.fauxclaude-status")
        try? fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? fm.removeItem(at: dest)
        try? fm.copyItem(at: src, to: dest)
    }

    func openLog() {
        NSWorkspace.shared.open(logURL)
    }

    func editModelMap() {
        // Seed the file with a commented-by-example default the first time, then
        // open it. Editing + restarting the shim applies the new routing.
        if !FileManager.default.fileExists(atPath: modelMapURL.path) {
            let template = """
            {
              "claude-haiku-4-5": "qwen3-vl:30b-a3b-instruct"
            }
            """
            try? template.write(to: modelMapURL, atomically: true, encoding: .utf8)
        }
        NSWorkspace.shared.open(modelMapURL)
    }

    // MARK: Ollama parallelism

    // Read the live OLLAMA_NUM_PARALLEL (defaults to 1 if unset).
    private static func readParallel() -> Int {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["getenv", "OLLAMA_NUM_PARALLEL"]
        let pipe = Pipe()
        p.standardOutput = pipe
        try? p.run()
        p.waitUntilExit()
        let s = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return Int(s) ?? 1
    }

    // Persist the value (LaunchAgent, so it survives login) and restart Ollama so
    // `serve` re-reads it. Killing only `ollama serve` won't do — the menu-bar app
    // respawns it with its own stale env, so we quit the whole app and reopen it.
    // The shim keeps running and auto-warms the model once Ollama is back.
    func applyParallel(_ n: Int) {
        writeParallelAgent(n)
        ollamaStatus = "restarting for parallel = \(n)…"
        let label = parallelAgentLabel
        let script = """
        launchctl setenv OLLAMA_NUM_PARALLEL \(n)
        launchctl unload ~/Library/LaunchAgents/\(label).plist 2>/dev/null
        launchctl load ~/Library/LaunchAgents/\(label).plist 2>/dev/null
        osascript -e 'quit app "Ollama"' 2>/dev/null
        sleep 2
        pkill -9 -f 'Ollama.app' 2>/dev/null
        sleep 1
        open -a Ollama
        """
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/zsh")
            p.arguments = ["-lc", script]
            try? p.run()
            p.waitUntilExit()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.poll() }
        }
    }

    private func writeParallelAgent(_ n: Int) {
        try? FileManager.default.createDirectory(
            at: parallelAgentURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
        \t<key>Label</key>
        \t<string>\(parallelAgentLabel)</string>
        \t<key>ProgramArguments</key>
        \t<array>
        \t\t<string>/bin/launchctl</string>
        \t\t<string>setenv</string>
        \t\t<string>OLLAMA_NUM_PARALLEL</string>
        \t\t<string>\(n)</string>
        \t</array>
        \t<key>RunAtLoad</key>
        \t<true/>
        </dict>
        </plist>
        """
        try? plist.write(to: parallelAgentURL, atomically: true, encoding: .utf8)
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
        Text(shim.running ? "FauxClaude: running (\(shim.mode)) on :\(shim.port)" : "FauxClaude: stopped")
        Text("Ollama: \(shim.ollamaStatus)")
        Divider()
        Button(shim.running ? "Stop FauxClaude" : "Start FauxClaude") { shim.toggle() }
            .keyboardShortcut("s")
        Toggle("Mock Mode (no Ollama, canned replies)", isOn: $shim.mockMode)
        Picker("Ollama Parallelism", selection: $shim.parallel) {
            Text("Interactive — 1 slot (fast, cached prefix)").tag(1)
            Text("Simulation — 4 slots (load testing)").tag(4)
        }
        Divider()
        Button("Open Dashboard") { shim.openDashboard() }
            .keyboardShortcut("d")
        Button("Run Claude Code in Terminal") { shim.runClaude() }
            .keyboardShortcut("t")
        Button("Open Project in VS Code…") { shim.openVSCode() }
            .keyboardShortcut("v")
        Button("View Log") { shim.openLog() }
        Button("Edit Model Map…") { shim.editModelMap() }
        Divider()
        Button("Quit (stops FauxClaude)") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}

// MARK: - Menu bar icon

enum MenuIcon {
    static let color = load("menubar-llama")
    static let dim = load("menubar-llama-dim")

    private static func load(_ name: String) -> NSImage {
        guard let path = Bundle.main.path(forResource: name, ofType: "png"),
              let img = NSImage(contentsOfFile: path) else {
            return NSImage(systemSymbolName: "theatermasks.circle", accessibilityDescription: "FauxClaude")!
        }
        let height: CGFloat = 22  // fill the menu bar; width follows aspect
        img.size = NSSize(width: img.size.width / max(img.size.height, 1) * height, height: height)
        return img
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillTerminate(_ notification: Notification) {
        ShimController.shared.stopProcess()
    }
}

@main
struct FauxClaudeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var shim = ShimController.shared

    var body: some Scene {
        MenuBarExtra {
            MenuContent(shim: shim)
        } label: {
            Image(nsImage: shim.running ? MenuIcon.color : MenuIcon.dim)
        }
    }
}
