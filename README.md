# FauxClaude 🦙

**100% locally sourced Claude.** A zero-dependency Node server that impersonates the
**Anthropic Messages API** in front of a local **Ollama** instance — free local Claude Code,
plus load- and integration-testing of Claude-compatible frontends without real API tokens.

Drop the FauxClaude logo at `assets/logo.png` and the dashboard will wear it.

```
Claude Code / Chatbox / LibreChat ──▶ http://127.0.0.1:11435 (this shim) ──▶ Ollama :11434
```

## Quick start

```sh
# 1. Have ollama running with at least one model
ollama serve &
ollama pull llama3.2

# 2. Start the shim
node server.mjs

# 3. Point any Claude client at it
ANTHROPIC_BASE_URL=http://127.0.0.1:11435 ANTHROPIC_AUTH_TOKEN=sk-test claude -p "say hi"
```

Any `x-api-key` is accepted. Any `claude-*` model name is routed to your Ollama model.

## Mock mode (no Ollama, zero cost, deterministic)

For pure load testing you don't even need Ollama — mock mode streams deterministic filler
text with configurable pacing:

```sh
MOCK=1 MOCK_DELAY_MS=15 MOCK_TOKENS=200 node server.mjs
```

## Recommended frontend: Claude Code

Claude Code honors `ANTHROPIC_BASE_URL`, exercises the full API surface (SSE streaming,
tool use, token counting, huge system prompts), and needs no extra install:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:11435 ANTHROPIC_AUTH_TOKEN=sk-test claude
```

> **Logged into claude.ai?** Set only `ANTHROPIC_BASE_URL` — no credential env
> var at all. Your login rides through to the shim (which ignores auth), and
> Claude Code shows no auth-conflict warning. Setting `ANTHROPIC_API_KEY` or
> `ANTHROPIC_AUTH_TOKEN` alongside a claude.ai login triggers the "auth may not
> work as expected" warning — and never `/logout` to silence it, that breaks
> your real claude.ai sessions. Only set `ANTHROPIC_AUTH_TOKEN=anything` if
> you're **not** logged in (Claude Code requires some credential to start).

GUI alternatives that accept a custom Anthropic base URL: **Chatbox**, **LibreChat**
(set the Anthropic reverse-proxy/base URL to `http://127.0.0.1:11435`). CORS is enabled,
so browser-based clients work too.

## The Mac app (no terminal required)

`FauxClaude.app` is a native menu bar app that owns everything. Drag it to
`/Applications` and launch it from Spotlight like any other app — no scripts, no
`cd`. It bundles its own copy of the shim, so the app is fully self-contained
(Node 18+ must be installed, e.g. `brew install node`).

From the bolt icon in the menu bar:

- **live status** — shim running/stopped + mode, Ollama up/down + model count
- **Start / Stop Shim** — the shim runs only while the app does; quitting stops it
- **Mock Mode** toggle — flip to canned replies (no Ollama) and back; restarts the shim
- **Open Dashboard** — the live GUI in your default browser
- **Run Claude Code in Terminal** — opens Terminal already wired to the shim
  (first use asks for Automation permission — that's macOS, allow it once)
- **View Shim Log** — `~/Library/Logs/fauxclaude.log`

Rebuild after changing `server.mjs` / `dashboard.html` / the Swift source with
`mac-app/build-app.sh` (dev-time only; requires Xcode command line tools).

## The Windows app (system tray)

`windows-app/` is the Windows equivalent — a .NET 8 WinForms **system tray app**
(the icons by the clock) with the same menu as the Mac app: shim status, Ollama
status, Start/Stop, Mock Mode toggle, Open Dashboard, Run Claude Code in Terminal
(prefers Windows Terminal, falls back to cmd), View Log, Exit. It bundles
`server.mjs`/`dashboard.html` next to the exe, logs to
`%LOCALAPPDATA%\fauxclaude\shim.log`, and double-clicking the tray icon
opens the dashboard.

Build on the Windows machine (needs the .NET 8 SDK — `winget install Microsoft.DotNet.SDK.8`):

```powershell
cd windows-app
dotnet publish -c Release -r win-x64 --self-contained false
# exe lands in bin\Release\net8.0-windows\win-x64\publish\
```

Prereqs on Windows: Node 18+ (`winget install OpenJS.NodeJS.LTS`), Ollama for
Windows, and the `claude` CLI.

## Daily driver: local Claude Code with zero token spend

The `claude-local` launchers start the shim if it isn't running and drop you into
Claude Code backed entirely by your local model:

```sh
# macOS / Linux
./claude-local                      # interactive
./claude-local -p "explain this repo"

# Windows (PowerShell or cmd — Ollama, Node, and Claude Code all run natively)
.\claude-local.ps1
claude-local.cmd -p "explain this repo"
```

Everything is plain Node + `claude`, so the same folder works on both OSes unchanged.
The launcher only sets env vars for its own child process — your normal `claude`
sessions (real API) are untouched.

**Pick a model that can actually drive tools.** Claude Code leans hard on tool calling
and long context; small chat models will flail. Reasonable choices, biggest first:

```sh
ollama pull qwen3-coder     # strong agentic/tool-calling coder (needs RAM/VRAM)
ollama pull devstral        # Mistral's agentic coding model
ollama pull qwen2.5-coder:14b
ollama pull llama3.1:8b     # lighter; fine for simple edits and Q&A
```

Route Claude Code's model tiers to different local models if you like:

```sh
MODEL_MAP='{"claude-opus-4-8":"qwen3-coder","claude-haiku-4-5":"llama3.2:3b"}' ./claude-local
```

Two defaults matter a lot here (both already set by the shim):

- **`NUM_CTX` (default 32768)** — Ollama's out-of-the-box context is ~4k tokens, which
  silently truncates Claude Code's system prompt and makes any model look broken.
  Raise it further if your hardware allows.
- **`KEEP_ALIVE` (default 30m)** — keeps the model loaded between turns so you don't
  pay a multi-second model reload on every message.

Set expectations: local models are far below real Claude at agentic coding. Simple
edits, explanations, and commit messages work well; long multi-step tool sessions
degrade with model size. That's the trade for free.

## Live dashboard

Open **http://127.0.0.1:11435/** in any browser while the shim is running. It shows,
updated live over SSE:

- mode / backend / default model chips
- stat tiles: total requests, active now, tokens in/out, and a 60-second
  output-tokens/sec sparkline
- a request table — status (streaming / done / error with the failure message),
  Claude model → Ollama model routing, stream flag, live-ticking token counts,
  duration, and a preview of the last user message

The last 200 requests are kept server-side, so reloading the page keeps history.
Light and dark mode follow the system setting. `claude-local` prints the URL on
launch.

## What's implemented

| Endpoint | Notes |
|---|---|
| `POST /v1/messages` | streaming (SSE) + non-streaming; system prompts; multi-turn; tool use (`tools`, `tool_use`, `tool_result`, `is_error`); base64 images; `stop_sequences`, `temperature`, `max_tokens`; thinking blocks passed through when the Ollama model emits them |
| `POST /v1/messages/count_tokens` | chars/4 estimate |
| `GET /v1/models`, `GET /v1/models/:id` | advertises current Claude model ids |
| `GET /` | live dashboard (see above) |
| `GET /events` | the dashboard's SSE feed (snapshot + per-request updates) |
| `GET /health` | mode, ollama url, model map |

Errors use the real Anthropic envelope (`{"type":"error","error":{...}}`). Usage numbers come
from Ollama's `prompt_eval_count` / `eval_count` when available.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `11435` | listen port |
| `OLLAMA_URL` | `http://localhost:11434` | your Ollama instance |
| `OLLAMA_MODEL` | first model in `/api/tags` | default backing model |
| `MODEL_MAP` | `{}` | JSON, per-Claude-model routing, e.g. `{"claude-opus-4-8":"llama3.1:70b","claude-haiku-4-5":"llama3.2:1b"}` |
| `MOCK` | off | `1` = built-in mock, no Ollama |
| `MOCK_DELAY_MS` / `MOCK_TOKENS` | `15` / `60` | mock pacing / response length |
| `LOG` | off | `1` = request logging |

## Load testing example

```sh
# 50 concurrent streaming requests
seq 50 | xargs -P 50 -I{} curl -sN http://127.0.0.1:11435/v1/messages \
  -H 'content-type: application/json' -H 'x-api-key: sk-test' \
  -d '{"model":"claude-opus-4-8","max_tokens":256,"stream":true,
       "messages":[{"role":"user","content":"request {}"}]}' -o /dev/null
```

Or use `hey`/`k6`/`vegeta` against `POST /v1/messages` with a non-streaming body.

## Known gaps (intentional)

- Token counts are estimates on the input side (Ollama has no tokenizer endpoint).
- No prompt caching (`cache_read_input_tokens` is always 0), batches, or files API.
- Server tools (`web_search` etc.) in the `tools` array are silently dropped.
- Tool-call quality depends entirely on the Ollama model — pick one with tool support
  (llama3.1+, qwen2.5, mistral-nemo) if your frontend relies on tool use.

## License

FauxClaude is free software licensed under the **GNU General Public License v3.0** —
see [LICENSE](LICENSE). You may use, study, share, and modify it; derivative works
must remain under the GPLv3.

Copyright © 2026 Garth Vander Houwen
