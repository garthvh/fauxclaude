// FauxClaude Status — a llama in the status bar that indicates whether THIS VS Code
// window is talking to your local FauxClaude shim, and whether the shim is up.
//
// "Routed" = this window's process has ANTHROPIC_BASE_URL pointed at the shim
// (which is exactly what the FauxClaude app's "Open Project in VS Code" does). A
// normal window won't have it, so the llama stays dim there — telling the two
// windows apart at a glance.
const vscode = require("vscode");
const http = require("http");

const DEFAULT_SHIM = "http://127.0.0.1:11435";

function activate(context) {
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || "").replace(/\/+$/, "");
  const routed = /(^|\/\/)(127\.0\.0\.1|localhost):11435/.test(baseUrl);
  const shimUrl = routed && baseUrl ? baseUrl : DEFAULT_SHIM;

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = "fauxclaude.openDashboard";
  context.subscriptions.push(item);

  context.subscriptions.push(
    vscode.commands.registerCommand("fauxclaude.openDashboard", () => {
      vscode.env.openExternal(vscode.Uri.parse(shimUrl + "/"));
    })
  );

  function render(up, mode, model) {
    const warnFg = new vscode.ThemeColor("statusBarItem.warningForeground");
    const warnBg = new vscode.ThemeColor("statusBarItem.warningBackground");
    if (routed) {
      item.text = up ? "🦙 FauxClaude" : "🦙 FauxClaude — offline";
      item.tooltip = up
        ? `This window is running on FauxClaude (${mode || "local"}${model ? " · " + model : ""}) at ${shimUrl}.\nClick to open the dashboard.`
        : `This window is set to use FauxClaude, but the shim isn't responding at ${shimUrl}.\nStart it from the FauxClaude menu-bar app.`;
      item.color = up ? undefined : warnFg;
      item.backgroundColor = up ? undefined : warnBg;
    } else {
      // Normal window (real Claude). Don't clutter unrelated windows: only show a
      // dim, informative llama when the shim is actually running elsewhere.
      if (!up) { item.hide(); return; }
      item.text = "$(circle-slash) 🦙";
      item.tooltip = `FauxClaude is running at ${shimUrl}, but THIS window is NOT routed to it (using the real API).\nUse the FauxClaude app's "Open Project in VS Code" to get a local window.`;
      item.color = new vscode.ThemeColor("disabledForeground");
      item.backgroundColor = undefined;
    }
    item.show();
  }

  async function poll() {
    let up = false, mode = "", model = "";
    try {
      const h = await getJson(shimUrl + "/health", 1200); // {ok, mode, default_model, ...}
      up = !!(h && h.ok === true);
      mode = (h && h.mode) || "";
      model = (h && h.default_model) || "";
    } catch (_) { /* shim down */ }
    render(up, mode, model);
  }

  poll();
  const timer = setInterval(poll, 4000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

// Minimal JSON GET (Node http, no dependencies).
function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
