// FauxClaude — 100% locally sourced Claude. Windows system tray app.
// Owns the FauxClaude server process: start/stop, mode toggle, dashboard, and a
// one-click Claude Code terminal pointed at the shim.
//
// Build:   dotnet publish -c Release -r win-x64 --self-contained false
// Run:     bin\Release\net8.0-windows\win-x64\publish\FauxClaude.exe
// Needs:   Node 18+ and the `claude` CLI on PATH.

using System.Diagnostics;
using System.Text.Json;

namespace FauxClaude;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApp());
    }
}

internal sealed class TrayApp : ApplicationContext
{
    private const int Port = 11435;
    private static string ShimUrl => $"http://127.0.0.1:{Port}";

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMilliseconds(1500) };

    private readonly NotifyIcon _tray = new();
    private readonly ToolStripMenuItem _statusLine = new("FauxClaude: starting…") { Enabled = false };
    private readonly ToolStripMenuItem _ollamaLine = new("Ollama: checking…") { Enabled = false };
    private readonly ToolStripMenuItem _toggleItem = new("Stop FauxClaude");
    private readonly ToolStripMenuItem _mockItem = new("Mock Mode (no Ollama, canned replies)") { CheckOnClick = true };
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 3000 };

    private Process? _shim;
    private bool _running;

    private static string AppDataDir
    {
        get
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                                   "fauxclaude");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    private static string LogPath => Path.Combine(AppDataDir, "shim.log");
    private static string ModelMapPath => Path.Combine(AppDataDir, "model-map.json");
    private static string MockFlagPath => Path.Combine(AppDataDir, "mock.flag");

    private bool MockMode
    {
        get => File.Exists(MockFlagPath);
        set { if (value) File.WriteAllText(MockFlagPath, "1"); else File.Delete(MockFlagPath); }
    }

    public TrayApp()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add(_statusLine);
        menu.Items.Add(_ollamaLine);
        menu.Items.Add(new ToolStripSeparator());

        _toggleItem.Click += (_, _) => ToggleShim();
        menu.Items.Add(_toggleItem);

        _mockItem.Checked = MockMode;
        _mockItem.CheckedChanged += (_, _) => { MockMode = _mockItem.Checked; RestartShim(); };
        menu.Items.Add(_mockItem);
        menu.Items.Add(new ToolStripSeparator());

        menu.Items.Add("Open Dashboard", null, (_, _) => OpenUrl($"{ShimUrl}/"));
        menu.Items.Add("Run Claude Code in Terminal", null, (_, _) => RunClaude());
        menu.Items.Add("View Log", null, (_, _) => OpenLog());
        menu.Items.Add("Edit Model Map…", null, (_, _) => EditModelMap());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit (stops FauxClaude)", null, (_, _) => ExitApp());

        var icoPath = Path.Combine(AppContext.BaseDirectory, "FauxClaude.ico");
        _tray.Icon = File.Exists(icoPath) ? new Icon(icoPath) : SystemIcons.Application;
        _tray.Text = "FauxClaude";
        _tray.ContextMenuStrip = menu;
        _tray.Visible = true;
        _tray.DoubleClick += (_, _) => OpenUrl($"{ShimUrl}/");

        StartShim();
        _timer.Tick += async (_, _) => await PollAsync();
        _timer.Start();
        _ = PollAsync();
    }

    // ---- shim process ------------------------------------------------------

    private void StartShim()
    {
        if (_shim is { HasExited: false }) return;
        var serverJs = Path.Combine(AppContext.BaseDirectory, "server.mjs");
        if (!File.Exists(serverJs))
        {
            MessageBox.Show($"server.mjs not found next to the exe:\n{serverJs}", "FauxClaude");
            return;
        }
        var psi = new ProcessStartInfo("node", $"\"{serverJs}\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.Environment["PORT"] = Port.ToString();
        psi.Environment["MOCK"] = MockMode ? "1" : "0";
        // Per-Claude-model routing comes from a persistent, user-editable file
        // (Edit Model Map… in the menu). The shim reads it and falls back to its
        // built-in fast-Haiku default when the file is absent. Opus/Sonnet default
        // to the larger model; both fall back if a model isn't installed — so on a
        // small-RAM box, pull ONLY qwen2.5-coder:7b and every tier routes to it.
        // NOTE: ProcessStartInfo.Environment is a Dictionary — its indexer THROWS
        // KeyNotFoundException on a missing key (it does not return null). Use
        // ContainsKey, or StartShim crashes on any machine where these aren't
        // already set as global env vars.
        if (!psi.Environment.ContainsKey("MODEL_MAP"))
            psi.Environment["MODEL_MAP_FILE"] = ModelMapPath;
        if (!psi.Environment.ContainsKey("OLLAMA_MODEL"))
            psi.Environment["OLLAMA_MODEL"] = "qwen2.5-coder:14b";
        try
        {
            var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
            var log = new StreamWriter(LogPath, append: false) { AutoFlush = true };
            p.OutputDataReceived += (_, e) => { if (e.Data != null) log.WriteLine(e.Data); };
            p.ErrorDataReceived += (_, e) => { if (e.Data != null) log.WriteLine(e.Data); };
            p.Exited += (_, _) => log.Dispose();
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            _shim = p;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            MessageBox.Show("Node.js not found on PATH. Install Node 18+ from https://nodejs.org " +
                            "(or `winget install OpenJS.NodeJS.LTS`).", "FauxClaude");
        }
    }

    private void StopShim()
    {
        try { if (_shim is { HasExited: false }) _shim.Kill(entireProcessTree: true); } catch { /* already gone */ }
        _shim = null;
    }

    private void ToggleShim()
    {
        if (_shim is { HasExited: false } || _running) StopShim(); else StartShim();
        _ = PollAsync();
    }

    private void RestartShim()
    {
        StopShim();
        StartShim();
    }

    // ---- actions -----------------------------------------------------------

    private static void OpenUrl(string url) =>
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });

    // Open a text file for viewing/editing. Do NOT shell out to notepad.exe: on
    // Windows 11 even the fully-qualified C:\Windows\System32\notepad.exe silently
    // hands off to the packaged (MSIX) Notepad through an activation contract that
    // drops the file argument and opens no discoverable window (see issue #3). Let
    // the shell open the file by its registered association instead — the same path
    // as double-clicking in Explorer, which the packaged app handles correctly:
    //   1. explorer.exe <path>  (reliably opens a real window via the file's handler)
    //   2. else ShellExecute the file directly
    //   3. else open the containing folder so the user can double-click it
    private static void OpenTextFile(string path)
    {
        var dir = Path.GetDirectoryName(path) ?? ".";
        try { Directory.CreateDirectory(dir); } catch { /* best effort */ }

        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{path}\"") { UseShellExecute = true });
            return;
        }
        catch { /* try ShellExecute on the file directly */ }
        try
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true, WorkingDirectory = dir });
            return;
        }
        catch { /* fall back to the folder */ }
        try { Process.Start(new ProcessStartInfo(dir) { UseShellExecute = true }); }
        catch { /* nothing more we can do */ }
    }

    private static void OpenLog()
    {
        if (!File.Exists(LogPath))
            try
            {
                File.WriteAllText(LogPath,
                    "FauxClaude hasn't written any log output yet.\r\n" +
                    "Start FauxClaude (or Run Claude Code in Terminal) to generate log entries.\r\n");
            }
            catch { /* opening will still surface whatever exists / reveal the folder */ }
        OpenTextFile(LogPath);
    }

    // Persistent per-Claude-model routing: %LOCALAPPDATA%\fauxclaude\model-map.json.
    // Seed it with a default the first time, then open it; the shim picks up changes
    // on its next start (Stop/Start FauxClaude).
    private static void EditModelMap()
    {
        if (!File.Exists(ModelMapPath))
            try
            {
                File.WriteAllText(ModelMapPath,
                    "{\r\n" +
                    "  \"claude-haiku-4-5\": \"qwen2.5-coder:7b\",\r\n" +
                    "  \"claude-opus-4-8\": \"qwen2.5-coder:14b\"\r\n" +
                    "}\r\n");
            }
            catch { /* opening will reveal the folder if the write failed */ }
        OpenTextFile(ModelMapPath);
    }

    private void RunClaude()
    {
        if (_shim is not { HasExited: false } && !_running) StartShim();
        // No credential env vars: Claude Code's claude.ai login rides through to
        // the shim (which ignores auth); setting one alongside a login triggers
        // Claude Code's auth-conflict warning. Empty `set X=` unsets in cmd.
        var cmd = $"set ANTHROPIC_API_KEY=&& set ANTHROPIC_AUTH_TOKEN=&& set ANTHROPIC_BASE_URL={ShimUrl}&& " +
                  "set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1&& set MAX_THINKING_TOKENS=1024&& " +
                  "claude --model haiku";  // light/snappy profile for a local model
        // prefer Windows Terminal when installed, fall back to plain cmd
        try
        {
            Process.Start(new ProcessStartInfo("wt.exe", $"cmd /k \"{cmd}\"") { UseShellExecute = true });
        }
        catch
        {
            Process.Start(new ProcessStartInfo("cmd.exe", $"/k \"{cmd}\"") { UseShellExecute = true });
        }
    }

    private void ExitApp()
    {
        StopShim();
        _tray.Visible = false;
        Application.Exit();
    }

    // ---- health polling ----------------------------------------------------

    private async Task PollAsync()
    {
        var up = false;
        var mode = "?";
        try
        {
            using var doc = JsonDocument.Parse(await Http.GetStringAsync($"{ShimUrl}/health"));
            up = doc.RootElement.TryGetProperty("ok", out var ok) && ok.GetBoolean();
            if (doc.RootElement.TryGetProperty("mode", out var m)) mode = m.GetString() ?? "?";
        }
        catch { /* not running */ }

        _running = up;
        _statusLine.Text = up ? $"FauxClaude: running ({mode}) on :{Port}" : "FauxClaude: stopped";
        _toggleItem.Text = up ? "Stop FauxClaude" : "Start FauxClaude";
        _tray.Text = up ? $"FauxClaude — running ({mode})" : "FauxClaude — stopped";

        if (MockMode) { _ollamaLine.Text = "Ollama: not needed (mock mode)"; return; }
        try
        {
            using var doc = JsonDocument.Parse(await Http.GetStringAsync("http://127.0.0.1:11434/api/tags"));
            var count = doc.RootElement.GetProperty("models").GetArrayLength();
            _ollamaLine.Text = count == 0
                ? "Ollama: running, no models — run `ollama pull <model>`"
                : $"Ollama: running ({count} model{(count == 1 ? "" : "s")})";
        }
        catch
        {
            _ollamaLine.Text = "Ollama: not running — start the Ollama app";
        }
    }
}
