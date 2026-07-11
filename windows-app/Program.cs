// Ollama Claude Shim — Windows system tray app.
// Owns the Node shim process: start/stop, mode toggle, dashboard, and a
// one-click Claude Code terminal pointed at the shim.
//
// Build:   dotnet publish -c Release -r win-x64 --self-contained false
// Run:     bin\Release\net8.0-windows\win-x64\publish\OllamaClaudeShim.exe
// Needs:   Node 18+ and the `claude` CLI on PATH.

using System.Diagnostics;
using System.Text.Json;

namespace OllamaClaudeShim;

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
    private readonly ToolStripMenuItem _statusLine = new("Shim: starting…") { Enabled = false };
    private readonly ToolStripMenuItem _ollamaLine = new("Ollama: checking…") { Enabled = false };
    private readonly ToolStripMenuItem _toggleItem = new("Stop Shim");
    private readonly ToolStripMenuItem _mockItem = new("Mock Mode (no Ollama, canned replies)") { CheckOnClick = true };
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 3000 };

    private Process? _shim;
    private bool _running;

    private static string AppDataDir
    {
        get
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                                   "ollama-claude-shim");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    private static string LogPath => Path.Combine(AppDataDir, "shim.log");
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
        menu.Items.Add("View Shim Log", null, (_, _) => OpenUrl(LogPath));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit (stops shim)", null, (_, _) => ExitApp());

        _tray.Icon = SystemIcons.Application;
        _tray.Text = "Ollama Claude Shim";
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
            MessageBox.Show($"server.mjs not found next to the exe:\n{serverJs}", "Ollama Claude Shim");
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
                            "(or `winget install OpenJS.NodeJS.LTS`).", "Ollama Claude Shim");
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

    private void RunClaude()
    {
        if (_shim is not { HasExited: false } && !_running) StartShim();
        // No credential env vars: Claude Code's claude.ai login rides through to
        // the shim (which ignores auth); setting one alongside a login triggers
        // Claude Code's auth-conflict warning. Empty `set X=` unsets in cmd.
        var cmd = $"set ANTHROPIC_API_KEY=&& set ANTHROPIC_AUTH_TOKEN=&& set ANTHROPIC_BASE_URL={ShimUrl}&& " +
                  "set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1&& claude";
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
        _statusLine.Text = up ? $"Shim: running ({mode}) on :{Port}" : "Shim: stopped";
        _toggleItem.Text = up ? "Stop Shim" : "Start Shim";
        _tray.Text = up ? $"Ollama Claude Shim — running ({mode})" : "Ollama Claude Shim — stopped";

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
