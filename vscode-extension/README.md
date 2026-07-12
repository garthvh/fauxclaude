# FauxClaude Status

A tiny status-bar llama for [FauxClaude](https://github.com/garthvh/fauxclaude).

- **🦙 FauxClaude** (lit) — this window's Claude Code is routed to your local
  FauxClaude shim and it's up. Tooltip shows the mode and default model.
- **🦙 FauxClaude — offline** (warning) — this window is set to use FauxClaude,
  but the shim isn't responding. Start it from the FauxClaude menu-bar app.
- **⦸ 🦙** (dim) — a normal window using the real API (not routed to FauxClaude).

Click the item to open the dashboard. "Routed" is detected from
`ANTHROPIC_BASE_URL` in the window's process — exactly what the FauxClaude app's
**Open Project in VS Code** sets — so you can tell your local window from your
normal one at a glance.

## Install (unpackaged)

Copy this folder into your VS Code extensions directory and reload:

```sh
cp -R vscode-extension ~/.vscode/extensions/fauxclaude-status
# then: Command Palette → "Developer: Reload Window"
```

No dependencies, no build step — plain JS against the shim's `/health`.
