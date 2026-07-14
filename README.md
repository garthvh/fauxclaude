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
# 1. Install Ollama as an app so it always runs (registers a login service
#    that starts on boot and stays up — no `ollama serve` to babysit).
brew install --cask ollama && open -a Ollama   # macOS
#    Windows: install "Ollama for Windows" from https://ollama.com/download

# 2. Pull at least one model
ollama pull qwen2.5-coder:14b

# 3. Start FauxClaude
node server.mjs

# 4. Point any Claude client at it
ANTHROPIC_BASE_URL=http://127.0.0.1:11435 ANTHROPIC_AUTH_TOKEN=sk-test claude -p "say hi"
```

> **Run Ollama as the app, not `ollama serve` in a terminal.** The app installs a
> background service that auto-starts on login and survives reboots, so Ollama is
> always ready when FauxClaude needs it. A manual `ollama serve &` dies when you
> close the terminal or reboot.

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
`cd`. It bundles its own copy of the shim, so the app is fully self-contained.

Prereqs: **Node 18+** (`brew install node`) and the **Ollama app** running in the
background (`brew install --cask ollama && open -a Ollama` — see Quick start above;
the app keeps Ollama serving across reboots).

From the llama in the menu bar:

- **live status** — shim running/stopped + mode, Ollama up/down + model count
- **Start / Stop Shim** — the shim runs only while the app does; quitting stops it
- **Mock Mode** toggle — flip to canned replies (no Ollama) and back; restarts the shim
- **Ollama Parallelism** — one-click switch between **Interactive** (`OLLAMA_NUM_PARALLEL=1`,
  keeps the prompt-prefix cache so turn 2+ are fast) and **Simulation** (4 slots, for load
  testing). It persists the value and restarts Ollama for you.
- **Open Dashboard** — the live GUI in your default browser
- **Run Claude Code in Terminal…** — pick a project folder; opens Terminal in it, wired to the shim
  (first use asks for Automation permission — that's macOS, allow it once)
- **Open Project in VS Code…** — pick a folder; opens it in an *isolated* VS Code instance
  pointed at the shim (see [VS Code](#vs-code) below)
- **View Shim Log** — `~/Library/Logs/fauxclaude.log`
- **Edit Model Map…** — opens `~/.fauxclaude-model-map.json` for persistent per-Claude-model routing (applies on next Stop/Start)

Rebuild after changing `server.mjs` / `dashboard.html` / the Swift source with
`mac-app/build-app.sh`, then install it: `ditto FauxClaude.app /Applications/FauxClaude.app`
(dev-time only; requires Xcode command line tools). `open -a FauxClaude` launches the
*installed* copy, so a rebuild in the repo won't take effect until you copy it over.

## The Windows app (system tray)

`windows-app/` is the Windows equivalent — a .NET 8 WinForms **system tray app**
(the icons by the clock). It bundles its own copy of the shim next to the exe, so
it's self-contained.

Prereqs: **Node 18+** (`winget install OpenJS.NodeJS.LTS`) and the **Ollama for
Windows** app running in the background (install from
<https://ollama.com/download/windows> or `winget install Ollama.Ollama` — like the
macOS app, it starts with Windows and keeps Ollama serving across reboots).

From the tray icon:

The Windows app is kept in **feature lock-step** with the Mac app — same menu:

- **live status** — shim running/stopped + mode, Ollama up/down + model count
- **Start / Stop FauxClaude** — the shim runs only while the app does; exiting stops it
- **Mock Mode** toggle — flip to canned replies (no Ollama) and back; restarts the shim
- **Ollama Parallelism** — Interactive (1) / Simulation (4); persists `OLLAMA_NUM_PARALLEL`
  (via the user env) and restarts Ollama
- **Open Dashboard** — the live GUI in your browser (double-clicking the tray icon also opens it)
- **Run Claude Code in Terminal…** — pick a folder; opens Windows Terminal (falls back to cmd) in it, wired to the shim
- **Open Project in VS Code…** — pick a folder; opens it in an isolated VS Code instance pointed at the shim
- **View Log** — `%LOCALAPPDATA%\fauxclaude\shim.log`
- **Edit Model Map…** — opens `%LOCALAPPDATA%\fauxclaude\model-map.json` for persistent per-Claude-model routing (applies on next Stop/Start)

Build on the Windows machine (needs the .NET 8 SDK — `winget install Microsoft.DotNet.SDK.8`):

```powershell
cd windows-app
dotnet publish -c Release -r win-x64 --self-contained false
# exe lands in bin\Release\net8.0-windows\win-x64\publish\
```

## VS Code

The VS Code Claude Code extension reads `ANTHROPIC_BASE_URL` from its **process
environment** at launch — a `settings.json` (VS Code *or* project-level `.claude/`)
can't redirect it. So **"Open Project in VS Code…"** launches a dedicated VS Code
instance (its own `--user-data-dir`, extensions shared) with the shim env set, opening
the folder you pick. That instance is pointed at FauxClaude; your normal VS Code is
untouched.

It also installs a tiny bundled extension, **FauxClaude Status** (`vscode-extension/`):
a 🦙 in the status bar that lights up in windows routed to the shim (and shows
"offline" if the shim is down). The isolated instance gets a **purple status bar** and
a "🦙 FauxClaude" window title so it's unmistakable.

> **macOS caveat:** there's only one "Visual Studio Code" app, so while the FauxClaude
> instance is running, folders you open via Finder/Dock get pulled *into* it and inherit
> the shim env. Keep the FauxClaude (purple) window for local work only; for normal
> projects, quit it first and open VS Code the normal way. The dashboard is the source
> of truth — a window that never shows up there isn't routed.

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
ollama pull qwen3-vl:30b-a3b-instruct  # MoE (~3B active → fast), vision + coding + tools, 256k ctx
ollama pull qwen3-coder                # strong agentic/tool-calling coder (needs RAM/VRAM)
ollama pull devstral                   # Mistral's agentic coding model
ollama pull qwen2.5-coder:14b
ollama pull llama3.1:8b                # lighter; fine for simple edits and Q&A
```

`qwen3-vl:30b-a3b-instruct` is a sweet spot: a Mixture-of-Experts model (only ~3B params
active per token, so prefill/generation stay fast), it **also does vision** (FauxClaude
forwards image blocks, so pasted screenshots work), and its 256k context leaves plenty of
room for Claude Code's big prompts. It's the **Mac app's default** on a roomy box (≥ 64 GB).

Route Claude Code's model tiers to different local models if you like:

```sh
MODEL_MAP='{"claude-opus-4-8":"qwen3-coder","claude-haiku-4-5":"llama3.2:3b"}' ./claude-local
```

A few defaults matter a lot here (all already set by the shim):

- **`NUM_CTX` (default 131072)** — Ollama's out-of-the-box context is ~4k tokens, which
  silently truncates Claude Code's system prompt. Claude Code conversations also *grow*
  past 32k, and if the prompt fills the whole window there's no room left to generate —
  replies truncate and Claude Code loops on "Output token limit hit". 128k leaves headroom.
  Ollama clamps this to the model's trained max (`ollama show` → context length), so a 32k
  model just gets 32k. **Lower it on a small-RAM box** (the KV cache grows with it).
- **`NUM_PREDICT_MAX` (default 16384)** — a hard cap on generated tokens. Local models
  occasionally run away (repetition loop); with a big context there's room to hit Claude
  Code's 32000 output guard and error. The cap turns a runaway into a harmless truncation.
- **`NUM_BATCH` (default 2048)** — prompt-eval (prefill) batch size; larger = faster
  prefill of Claude Code's big prompts.
- **`KEEP_ALIVE` (default -1 = forever)** — keeps the model resident so you never
  pay the cold model-load after an idle gap (the worst local-model latency). The
  shim also pre-loads the model whenever Ollama becomes reachable — at launch and
  after any restart — so it's warm before your first request. Set a duration
  (`KEEP_ALIVE=30m`) or `0` to unload sooner if you'd rather reclaim the RAM when idle.

Set expectations: local models are far below real Claude at agentic coding. Simple
edits, explanations, and commit messages work well; long multi-step tool sessions
degrade with model size. That's the trade for free.

## Making it faster (simulation / load testing)

Generation speed is **memory-bandwidth bound** — each token streams the model's
weights through memory once — so the model size, not the front-end, sets the pace.
Swapping Ollama for llama.cpp directly does **not** help (Ollama *is* llama.cpp
underneath); flash attention is a wash on Apple Silicon. The levers that actually
move the needle:

- **Fewer active params = faster.** A smaller (or Mixture-of-Experts) model streams
  fewer weights per token. The shim's built-in default routes the Haiku tier to
  `qwen2.5-coder:7b` (~60 tok/s vs ~32 for the 14b) when it's installed; MoE models
  like `qwen3-vl:30b-a3b-instruct` are fast *and* capable because only ~3B params are
  active. Change routing with `MODEL_MAP` / `OLLAMA_MODEL` (a tier pointing at a model
  you haven't pulled falls back automatically). For an even faster sim, pull a 3b
  (`qwen2.5-coder:3b`, `llama3.2:3b`) and map Haiku to it.
- **Concurrency batching for many parallel requests.** Ollama defaults
  `OLLAMA_NUM_PARALLEL` to 1, so a sim firing N requests at once *serializes* them.
  Raise it and the GPU batches them, multiplying aggregate throughput. The app's
  **Ollama Parallelism** menu flips this for you (and restarts Ollama); by hand it's
  `launchctl setenv OLLAMA_NUM_PARALLEL 4` then quit/reopen Ollama on macOS, or the
  `OLLAMA_NUM_PARALLEL` user env var + restart on Windows. **But keep it at `1` for
  *interactive* Claude Code:** extra slots split the KV cache so consecutive turns land
  on empty slots and re-prefill the whole ~20–30k-token prompt (~100s on a 14b) instead
  of reusing the cached prefix. One slot = fast warm turns; raise it only for sims.
  (Some ggml/Metal builds have had concurrency crashes — confirm stability.)
- **Auto warm-up on restart.** When Ollama restarts (reboot, quit/reopen, crash),
  it unloads every model, so the next request would pay the cold model-load. The
  shim watches Ollama's reachability and, on a down→up transition, fires a tiny
  `"hi"` query to pre-load the model your traffic last used — warm before you need it.
- **Pure load, no model?** Mock mode (`MOCK=1` / the app's Mock Mode toggle)
  returns deterministic streamed responses with zero inference — unlimited req/s.
  Use it when you're stress-testing the client/shim/harness rather than the model.

### Sizing to your RAM

Generation and KV cache both live in RAM (unified memory on Apple Silicon), so the
budget matters. The KV cache grows with `NUM_CTX` (**128k default**) *and* with each
parallel slot, and holding two models resident costs both weight sets. On a small box,
drop `NUM_CTX` — that's the biggest lever.

| Box RAM | Recommended setup |
|---|---|
| **≥ 64 GB** | `qwen3-vl:30b-a3b-instruct` (~19 GB, vision + coding, MoE-fast) as the single default — the Mac app's default. Or 7b + 14b both resident, `OLLAMA_NUM_PARALLEL=4` for sims. |
| **32 GB** | Pull **only** `qwen2.5-coder:7b` (~4.7 GB) — every tier falls back to it, so the 9 GB 14b never loads. Drop `NUM_CTX` to `32768` (or less), `OLLAMA_NUM_PARALLEL=1` interactive / `2` for sims. |
| **16 GB** | `qwen2.5-coder:3b` (~2 GB) or `llama3.2:3b`, `NUM_CTX=16384`, `OLLAMA_NUM_PARALLEL=1`. Or mock mode. |

If you keep both models on a 32 GB box, set `OLLAMA_MAX_LOADED_MODELS=1` so Ollama
holds one at a time (it reloads when you switch tiers) rather than risking an OOM —
this matters more now that `KEEP_ALIVE` defaults to -1 (models stay resident and
won't idle-evict on their own).

## Live dashboard

Open **http://127.0.0.1:11435/** in any browser while the shim is running. It shows,
updated live over SSE:

- mode / backend / default model chips
- stat tiles: total requests, active now, tokens in/out, a 60-second
  output-tokens/sec sparkline, and **"Saved at Claude API rates"** — an all-time,
  persisted estimate of what this traffic would have cost on the real Claude API,
  priced per request against the model the client asked for (Opus $5/$25, Sonnet
  $3/$15, Haiku $1/$5, Fable $10/$50 per MTok). It's **cache-aware**: Claude Code
  re-sends a large stable `system`+`tools` block every turn, so that block is
  modelled as a cache read (0.1×) after the first request within the 5-min TTL and
  a write (1.25×) the first time — the tile shows the % of input served from cache
  and a per-tier cost split. (Conversation-history caching isn't modelled, so long
  sessions are slightly over-estimated.)
- a request table — status (streaming / done / error with the failure message /
  **canceled** in orange when the client disconnects mid-request), Claude model →
  Ollama model routing, stream flag, live-ticking token counts, duration, and a
  preview of the last user message (system-reminder / interrupt boilerplate stripped
  so you see what was actually typed)

Up to **~2000 requests** are kept server-side (`MAX_ACTIVITY`) with client-side table
paging, so reloading the page keeps history. When Claude Code interrupts a request
(Esc), the shim aborts the upstream Ollama call and marks the row canceled instead of
leaving it stuck "active". Light and dark mode follow the system setting. `claude-local`
prints the URL on launch.

## What's implemented

| Endpoint | Notes |
|---|---|
| `POST /v1/messages` | streaming (SSE) + non-streaming; system prompts; multi-turn; tool use (`tools`, `tool_use`, `tool_result`, `is_error`); base64 images; base64 PDF `document` blocks (rasterized to page images — see below); `stop_sequences`, `temperature`, `max_tokens`; thinking blocks passed through when the Ollama model emits them |
| `POST /v1/messages/count_tokens` | chars/4 estimate |
| `GET /v1/models`, `GET /v1/models/:id` | advertises current Claude model ids |
| `GET /` | live dashboard (see above) |
| `GET /events` | the dashboard's SSE feed (snapshot + per-request updates) |
| `GET /health` | mode, ollama url, default model, model map |

Errors use the real Anthropic envelope (`{"type":"error","error":{...}}`). Usage numbers come
from Ollama's `prompt_eval_count` / `eval_count` when available.

## PDF documents

Ollama's vision models take images only, so a Claude `document` block (a base64 PDF —
the shape Claude Code's document-extraction workloads send) is rasterized to page
images and fed through the same path as an `image` block, capped at the first
`PDF_MAX_PAGES` pages. Two rasterizers, tried in order:

1. **poppler's `pdftoppm`**, if installed — no npm dependency at all.
   `brew install poppler` (macOS) / `apt install poppler-utils` (Linux) / part of most
   Windows poppler builds.
2. **`pdf-to-img`** (optional npm dependency, pinned to `4.5.0` — the last version
   supporting Node 18; 5.x+ needs Node 20+) — `npm install` in this repo pulls it in,
   for boxes without poppler. No system tool required, but it depends on `canvas`
   (a native module with prebuilt binaries for common platforms).

Neither installed → the document is dropped (today's behavior before this feature),
but with a clear one-time log line telling you how to enable it, instead of silently
answering from the prompt text alone. **Extraction quality depends on the backing
model being vision-capable** (`qwen3-vl`, `qwen2.5vl`, `granite3.2-vision` — not
`llama3.2-vision`, which errors on some Ollama builds with `unknown model
architecture: 'mllama'`).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `11435` | listen port |
| `OLLAMA_URL` | `http://localhost:11434` | your Ollama instance |
| `OLLAMA_MODEL` | first model in `/api/tags` | default backing model (non-mapped tiers) |
| `MODEL_MAP` | `{"claude-haiku-4-5":"qwen2.5-coder:7b"}` | JSON, per-Claude-model routing, e.g. `{"claude-opus-4-8":"llava:7b","claude-haiku-4-5":"qwen2.5-coder:7b"}` |
| `MODEL_MAP_FILE` | — | path to a JSON file with the same shape as `MODEL_MAP`; **persistent, editable routing without env vars.** `MODEL_MAP` (if set) wins; else this file; else the built-in default. A model that isn't installed falls back automatically. |
| `NUM_CTX` | `131072` | Ollama context window (clamped to the model's trained max) |
| `NUM_PREDICT_MAX` | `16384` | hard cap on generated tokens per request (runaway guard) |
| `NUM_BATCH` | `2048` | prompt-eval (prefill) batch size |
| `KEEP_ALIVE` | `-1` | how long Ollama keeps the model loaded (`-1` = forever, `0` = unload now, or a duration like `30m`) |
| `MAX_ACTIVITY` | `2000` | requests retained server-side for the dashboard |
| `PDF_MAX_PAGES` | `5` | pages rasterized per PDF `document` block |
| `PDF_RENDER_DPI` | `150` | DPI used to rasterize PDF pages to images |
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
- No real prompt caching, batches, or files API (API responses always report
  `cache_read_input_tokens: 0` — though the savings estimate *models* caching).
- Server tools (`web_search` etc.) in the `tools` array are silently dropped.
- Tool-call quality depends entirely on the Ollama model — pick one with tool support
  (llama3.1+, qwen2.5, mistral-nemo) if your frontend relies on tool use.
- PDF `document` blocks need poppler or `npm install` (the `pdf-to-img` optional
  dependency) to rasterize — see [PDF documents](#pdf-documents). Non-`application/pdf`
  document media types aren't supported.
- `npm install`'s transitive `tar`/`@mapbox/node-pre-gyp` (via the optional `canvas`
  native dependency) has open high-severity advisories with no non-breaking fix
  available yet; it's install-time-only (fetches a prebuilt binary from a trusted
  source) and not exercised while the shim is running. Skip `npm install` entirely if
  you only use the poppler rasterizer.

## License

FauxClaude is free software licensed under the **GNU General Public License v3.0** —
see [LICENSE](LICENSE). You may use, study, share, and modify it; derivative works
must remain under the GPLv3.

Copyright © 2026 Garth Vander Houwen
