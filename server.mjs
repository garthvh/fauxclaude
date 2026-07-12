#!/usr/bin/env node
// FauxClaude — 100% locally sourced Claude. Pretends to be the Anthropic Messages API, backed by a
// local Ollama instance (or a built-in mock). Zero dependencies, Node 18+.
//
//   PORT=11435 OLLAMA_URL=http://localhost:11434 OLLAMA_MODEL=llama3.2 node server.mjs
//   MOCK=1 node server.mjs        # no Ollama needed — canned streaming responses
//
// Implements:
//   POST /v1/messages               (streaming + non-streaming, tools, images)
//   POST /v1/messages/count_tokens  (chars/4 estimate)
//   GET  /v1/models, /v1/models/:id
//
// Env:
//   PORT            listen port                     (default 11435)
//   OLLAMA_URL      ollama base url                 (default http://localhost:11434)
//   OLLAMA_MODEL    default ollama model            (default: first model in /api/tags)
//   MODEL_MAP       JSON: {"claude-opus-4-8":"llama3.2", ...} per-model routing
//   NUM_CTX         ollama context window in tokens (default 32768 — Ollama's own
//                   default of ~4k silently truncates Claude Code's system prompt)
//   KEEP_ALIVE      how long ollama keeps the model loaded (default "30m")
//   MOCK            "1" to bypass Ollama entirely
//   MOCK_DELAY_MS   per-token delay in mock mode    (default 15)
//   MOCK_TOKENS     tokens per mock response        (default 60)
//   LOG             "1" for request logging

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DASHBOARD_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard.html");

const PORT = Number(process.env.PORT || 11435);
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/$/, "");
const MOCK = process.env.MOCK === "1";
const MOCK_DELAY_MS = Number(process.env.MOCK_DELAY_MS || 15);
const MOCK_TOKENS = Number(process.env.MOCK_TOKENS || 60);
const LOG = process.env.LOG === "1";
// Slot size, capped by the model's trained context. 128k gives Claude Code room:
// its conversations grow past 32k, and if the prompt fills the whole window there
// are ~no tokens left to generate — the reply truncates and Claude Code loops on
// "Output token limit hit". qwen3-vl supports 256k, so 131072 leaves headroom
// (raise to 262144 if a long session still hits the ceiling). Note this grows the
// KV cache; fine on 96GB. Ollama clamps to the model's trained max.
// (Separately, keep OLLAMA_NUM_PARALLEL=1 for interactive use so turns reuse the
// cached prefix instead of round-robining onto empty slots and re-prefilling.)
const NUM_CTX = Number(process.env.NUM_CTX || 131072);
// Prompt-eval (prefill) batch size. Claude Code prompts are big (~20-30k tokens),
// and prefill is the dominant local-latency cost; a larger batch speeds it up.
// Ollama otherwise picks a conservative 1024 for larger models. Reloads the model
// once when it changes, like num_ctx.
const NUM_BATCH = Number(process.env.NUM_BATCH || 2048);
// Hard ceiling on generated tokens. Claude Code requests a large max_tokens and
// errors if a response exceeds its CLAUDE_CODE_MAX_OUTPUT_TOKENS guard (32000). A
// local model occasionally runs away (repetition loop) and, with a big num_ctx,
// can generate to that ceiling — tripping the client error and wasting minutes of
// generation. Capping num_predict well under the guard turns a runaway into a
// harmless truncated reply. 16k is far above any normal coding response; raise
// NUM_PREDICT_MAX for genuinely huge single outputs.
const NUM_PREDICT_MAX = Number(process.env.NUM_PREDICT_MAX || 16384);
// How long Ollama keeps the model loaded. Default -1 = forever, so you never pay a
// cold reload after an idle gap (the model load is the worst local-model latency).
// Override with a duration ("30m") or seconds ("0" unloads immediately). Numeric
// strings are sent as seconds; -1 = infinite.
const KEEP_ALIVE_ENV = (process.env.KEEP_ALIVE ?? "-1").trim();
const KEEP_ALIVE = /^-?\d+$/.test(KEEP_ALIVE_ENV) ? Number(KEEP_ALIVE_ENV) : KEEP_ALIVE_ENV;
// Per-Claude-model → Ollama-model routing. Resolution order:
//   1. MODEL_MAP env var (explicit JSON string) — power users / CLI / one-offs.
//   2. MODEL_MAP_FILE env var → read that JSON file — the native apps point this
//      at a persistent, user-editable config so routing survives reboots/relaunches
//      with no env-var wrangling (see the app "Edit Model Map…" menu items).
//   3. Built-in default (fast Haiku tier), overridable by either of the above.
// A malformed/unreadable source falls back to the next, never crashes.
const DEFAULT_MODEL_MAP = { "claude-haiku-4-5": "qwen2.5-coder:7b" };
const MODEL_MAP = (() => {
  if (process.env.MODEL_MAP) {
    try { return JSON.parse(process.env.MODEL_MAP); }
    catch { console.error("[fauxclaude] MODEL_MAP is not valid JSON — ignoring"); }
  }
  const file = process.env.MODEL_MAP_FILE;
  if (file && fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      console.log(`[fauxclaude] model map loaded from ${file}`);
      return parsed;
    } catch { console.error(`[fauxclaude] ${file} is not valid JSON — using default routing`); }
  }
  return DEFAULT_MODEL_MAP;
})();

let defaultOllamaModel = process.env.OLLAMA_MODEL || null;
let lastOllamaModel = null; // most-recently-used backing model — the one to warm after a restart

const log = (...a) => { if (LOG) console.log(new Date().toISOString(), ...a); };
const genId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;

// ---------------------------------------------------------------- helpers

function anthropicError(res, status, type, message) {
  res.writeHead(status, { "content-type": "application/json", ...corsHeaders() });
  res.end(JSON.stringify({ type: "error", error: { type, message }, request_id: genId("req") }));
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, authorization",
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Rough token estimate — good enough for count_tokens and mock usage numbers.
function estimateTokens(obj) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj);
  return Math.max(1, Math.ceil(text.length / 4));
}

async function resolveOllamaModel(claudeModel) {
  // Re-resolve on every request (~1ms against localhost) so pulling/deleting
  // models in Ollama takes effect without restarting the shim.
  const resp = await fetch(`${OLLAMA_URL}/api/tags`);
  const tags = await resp.json();
  const installed = (tags.models || []).map((m) => m.name);
  if (!installed.length) throw new Error("No models installed in Ollama — run `ollama pull <model>`");

  // Both the per-tier MODEL_MAP entry and the OLLAMA_MODEL default win only if
  // that model is actually installed — a mapping/default to a model that isn't
  // pulled falls through instead of hard-erroring (handy when swapping models).
  const has = (name) => name && (installed.includes(name) || installed.includes(name + ":latest"));

  // Match MODEL_MAP by exact key, else by prefix — Claude Code sends date-suffixed
  // IDs for some calls (e.g. "claude-haiku-4-5-20251001"), which must still hit the
  // undated "claude-haiku-4-5" map entry rather than falling through to the default.
  let mapped = MODEL_MAP[claudeModel];
  if (!mapped) {
    const key = Object.keys(MODEL_MAP).find((k) => claudeModel.startsWith(k));
    if (key) mapped = MODEL_MAP[key];
  }
  if (has(mapped)) return mapped;

  if (has(process.env.OLLAMA_MODEL)) return process.env.OLLAMA_MODEL;

  const picked = installed[0];
  if (picked !== defaultOllamaModel) {
    defaultOllamaModel = picked;
    console.log(`[fauxclaude] defaulting to ollama model: ${picked}`);
  }
  return picked;
}

// ------------------------------------------------------- activity feed (GUI)

const activity = [];            // capped ring buffer of request records
const dashClients = new Set();  // open /events SSE responses
const MAX_ACTIVITY = Number(process.env.MAX_ACTIVITY || 2000);

// ------------------------------------------- lifetime "tokens saved" counter

// What this traffic would have cost on the real Claude API, priced per request
// against the Claude model the client asked for. $/MTok input, output.
function apiRates(model) {
  const m = String(model || "").toLowerCase();
  if (m.includes("fable") || m.includes("mythos")) return [10, 50];
  if (m.includes("opus")) return [5, 25];
  if (m.includes("haiku")) return [1, 5];
  return [3, 15]; // sonnet and anything unrecognized
}
function tierName(model) {
  const m = String(model || "").toLowerCase();
  if (m.includes("fable") || m.includes("mythos")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  return "sonnet";
}

// Prompt-caching model. Claude Code re-sends a large stable block (tools + system,
// ~26k tokens) every turn; on the real API that block is a cache READ at 0.1x input
// rate after the first request within the 5-minute ephemeral TTL, and a cache WRITE
// at 1.25x the first time. The rest (the conversation) is billed at full rate. We
// detect the stable block by hashing tools+system and remembering when we last saw
// it. (Approximation: conversation-history caching isn't modeled, so long sessions
// are slightly over-estimated — still far closer than charging full rate for the
// 26k system prompt every turn, which the old estimate did.)
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_READ_MULT = 0.1, CACHE_WRITE_MULT = 1.25;
const seenPrefixes = new Map(); // sha1(tools+system) -> lastSeenMs

function cacheSplit(body) {
  const prefix = JSON.stringify(body.tools ?? "") + " " + JSON.stringify(body.system ?? "");
  const prefixChars = body.tools || body.system ? prefix.length : 0;
  const totalChars = prefixChars + JSON.stringify(body.messages ?? []).length;
  const fraction = totalChars > 0 ? prefixChars / totalChars : 0;
  let hit = false;
  if (prefixChars > 1000) { // only a substantial prefix is worth caching (API min ~1k tok)
    const hash = crypto.createHash("sha1").update(prefix).digest("hex");
    const now = Date.now();
    const last = seenPrefixes.get(hash);
    hit = last != null && now - last < CACHE_TTL_MS;
    seenPrefixes.set(hash, now);
    if (seenPrefixes.size > 256) {
      for (const [k, t] of seenPrefixes) if (now - t > CACHE_TTL_MS) seenPrefixes.delete(k);
    }
  }
  return { fraction, hit };
}

const STATS_FILE = path.join(os.homedir(), ".fauxclaude-stats.json");
const LEGACY_STATS_FILE = path.join(os.homedir(), ".ollama-claude-shim-stats.json"); // pre-rebrand
const STATS_VERSION = 2; // bumped when the cost model changes → reset on mismatch
function freshTotals() {
  return {
    v: STATS_VERSION, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, fullInputTokens: 0, byTier: {}, since: Date.now(),
  };
}
let totals = freshTotals();
try {
  const src = fs.existsSync(STATS_FILE) ? STATS_FILE : LEGACY_STATS_FILE;
  const loaded = JSON.parse(fs.readFileSync(src, "utf8"));
  if (loaded.v === STATS_VERSION) totals = { ...totals, ...loaded }; // else keep fresh (model changed)
} catch { /* first run */ }
let statsDirty = false;
setInterval(() => {
  if (!statsDirty) return;
  statsDirty = false;
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(totals)); } catch { /* non-fatal */ }
}, 5000).unref();

function countSaved(rec) {
  const [rin, rout] = apiRates(rec.model);
  const input = rec.inputTokens || 0;
  const output = rec.outputTokens || 0;

  const prefixTokens = Math.round(input * (rec._cacheFraction || 0));
  const newTokens = input - prefixTokens;
  const readTokens = rec._cacheHit ? prefixTokens : 0;
  const writeTokens = rec._cacheHit ? 0 : prefixTokens;

  const inputCost = (readTokens * CACHE_READ_MULT + writeTokens * CACHE_WRITE_MULT + newTokens) / 1e6 * rin;
  const outputCost = output / 1e6 * rout;
  const cost = inputCost + outputCost;

  totals.requests += 1;
  totals.inputTokens += input;
  totals.outputTokens += output;
  totals.cacheReadTokens += readTokens;
  totals.cacheWriteTokens += writeTokens;
  totals.fullInputTokens += newTokens;
  totals.costUsd += cost;
  const tier = tierName(rec.model);
  totals.byTier[tier] = (totals.byTier[tier] || 0) + cost;
  statsDirty = true;
}

// The live feed carries metadata + preview only; full bodies are fetched on
// demand via GET /requests/:id.
const publicRec = ({ _start, _lastPush, _cacheFraction, _cacheHit, _done, userMessage, responseText, ...pub }) => pub;

// Chars kept per stored message/response for the detail view. Bounded because we
// now retain up to MAX_ACTIVITY (~2000) records — 2000 × 200KB × 2 would be ~800MB.
const BODY_CAP = 32_000;

function appendResponse(rec, text) {
  if (rec.responseText.length < BODY_CAP) rec.responseText += text;
}

function broadcast(rec) {
  const line = `data: ${JSON.stringify({ type: "update", record: publicRec(rec), totals })}\n\n`;
  for (const client of dashClients) client.write(line);
}

function track(body, inputTokens) {
  const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === "user");
  const { fraction, hit } = cacheSplit(body); // cost model: what share is cacheable + was it a cache hit
  const rec = {
    id: genId("act"), ts: Date.now(), model: body.model, ollamaModel: null,
    stream: !!body.stream, status: "active", inputTokens, outputTokens: 0,
    durationMs: null, stopReason: null, error: null,
    preview: humanText(lastUser?.content).slice(0, 200),
    userMessage: blockText(lastUser?.content ?? "").slice(0, BODY_CAP),
    responseText: "",
    _start: Date.now(), _lastPush: 0, _cacheFraction: fraction, _cacheHit: hit,
  };
  activity.push(rec);
  if (activity.length > MAX_ACTIVITY) activity.shift();
  broadcast(rec);
  return rec;
}

// throttled live update (streaming token ticks)
function tick(rec) {
  const now = Date.now();
  if (now - rec._lastPush > 150) { rec._lastPush = now; broadcast(rec); }
}

function finish(rec, fields) {
  if (rec._done) return;  // first terminal state wins (e.g. a client-cancel beats a late "done")
  rec._done = true;
  Object.assign(rec, fields, { durationMs: Date.now() - rec._start });
  if (rec.status === "done") countSaved(rec); // errors/cancels wouldn't have billed on the real API
  broadcast(rec);
}

// ------------------------------------------- Anthropic -> Ollama translation

function systemToString(system) {
  if (!system) return null;
  if (typeof system === "string") return system;
  return system.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  return JSON.stringify(content);
}

// The human's actual text for the dashboard preview. Claude Code wraps each user
// turn with injected <system-reminder>…</system-reminder> context blocks; strip
// them so the column shows what was typed, not the boilerplate. Falls back to the
// raw text for turns that are only injected content (e.g. tool-result turns).
function humanText(content) {
  const raw = blockText(content ?? "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ");
  // After an interrupt, Claude Code folds the aborted turn(s) plus a
  // "[Request interrupted by user]" marker into the same user message; the actual
  // new message is whatever the user typed after the last such marker.
  const segments = raw.split(/\[Request interrupted by user[^\]]*\]/gi);
  const tail = segments[segments.length - 1].replace(/\s+/g, " ").trim();
  return tail || raw.replace(/\s+/g, " ").trim();
}

function anthropicToOllamaMessages(body) {
  const out = [];
  const sys = systemToString(body.system);
  if (sys) out.push({ role: "system", content: sys });

  for (const msg of body.messages || []) {
    if (msg.role === "system") { // mid-conversation system message
      out.push({ role: "system", content: blockText(msg.content) });
      continue;
    }
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    // Block content
    const texts = [];
    const images = [];
    const toolCalls = [];
    const toolResults = [];
    for (const block of msg.content || []) {
      switch (block.type) {
        case "text":
          texts.push(block.text);
          break;
        case "image":
          if (block.source?.type === "base64") images.push(block.source.data);
          break;
        case "tool_use":
          toolCalls.push({ function: { name: block.name, arguments: block.input || {} } });
          break;
        case "tool_result": {
          const content = typeof block.content === "string" ? block.content : blockText(block.content);
          toolResults.push({ role: "tool", content: block.is_error ? `ERROR: ${content}` : content });
          break;
        }
        case "thinking":
        case "redacted_thinking":
          break; // internal — don't replay to ollama
        default:
          texts.push(`[unsupported block: ${block.type}]`);
      }
    }
    // tool results come back as role:"tool" messages in ollama
    for (const tr of toolResults) out.push(tr);
    if (texts.length || images.length || toolCalls.length) {
      const m = { role: msg.role, content: texts.join("\n") };
      if (images.length) m.images = images;
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
    }
  }
  return out;
}

function anthropicToolsToOllama(tools) {
  if (!tools?.length) return undefined;
  return tools
    .filter((t) => t.input_schema) // skip server tools (web_search etc.)
    .map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema },
    }));
}

function mapStopReason(ollamaDoneReason, hadToolCalls) {
  if (hadToolCalls) return "tool_use";
  if (ollamaDoneReason === "length") return "max_tokens";
  return "end_turn";
}

// ---------------------------------------------------------------- SSE writer

class SSE {
  constructor(res) {
    this.res = res;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...corsHeaders(),
    });
  }
  send(event, data) {
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  end() { this.res.end(); }
}

function messageStartPayload(msgId, model, inputTokens) {
  return {
    type: "message_start",
    message: {
      id: msgId, type: "message", role: "assistant", model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 1,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

// ---------------------------------------------------------------- /v1/messages

async function handleMessages(req, res, body) {
  const claudeModel = body.model || "claude-opus-4-8";
  const msgId = genId("msg");
  const inputTokens = estimateTokens({ system: body.system, messages: body.messages, tools: body.tools });
  const rec = track(body, inputTokens);

  // Propagate a client disconnect (Claude Code's Esc/interrupt) upstream: abort the
  // Ollama request so it stops generating and releases the slot — otherwise the
  // abandoned request keeps the (single, with np=1) slot busy and the record is
  // stranded "active" forever. Fires only on an *early* close, not normal end.
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded && !rec._done) {
      finish(rec, { status: "canceled", error: "client disconnected before completion" });
      ac.abort();
    }
  });

  try {
    if (MOCK) return await handleMock(res, body, claudeModel, msgId, inputTokens, rec, ac);
    return await handleOllama(res, body, claudeModel, msgId, inputTokens, rec, ac);
  } catch (err) {
    if (ac.signal.aborted) return;  // already finalized as canceled above
    const msg = err?.cause?.code === "ECONNREFUSED" || err?.message === "fetch failed"
      ? `Cannot reach Ollama at ${OLLAMA_URL} — is \`ollama serve\` running?`
      : String(err?.message || err);
    finish(rec, { status: "error", error: msg });
    throw err;
  }
}

async function handleOllama(res, body, claudeModel, msgId, inputTokens, rec, ac) {
  const ollamaModel = await resolveOllamaModel(claudeModel);
  rec.ollamaModel = ollamaModel;
  lastOllamaModel = ollamaModel;
  const ollamaReq = {
    model: ollamaModel,
    messages: anthropicToOllamaMessages(body),
    tools: anthropicToolsToOllama(body.tools),
    stream: !!body.stream,
    keep_alive: KEEP_ALIVE,
    options: { num_ctx: NUM_CTX, num_batch: NUM_BATCH },
  };
  ollamaReq.options.num_predict = Math.min(body.max_tokens || NUM_PREDICT_MAX, NUM_PREDICT_MAX);
  if (body.temperature != null) ollamaReq.options.temperature = body.temperature;
  if (body.top_p != null) ollamaReq.options.top_p = body.top_p;
  if (body.stop_sequences?.length) ollamaReq.options.stop = body.stop_sequences;

  // Structured outputs: translate Anthropic's schema-constrained output into
  // Ollama's native `format` field, which drives Ollama's own constrained
  // decoding — so callers using output_config.format get schema-valid JSON back
  // (which JSON.parse) instead of free-form prose. The canonical Anthropic shape
  // is output_config.format.{type:"json_schema", schema}; we also accept the
  // deprecated top-level output_format alias and a .json_schema field spelling.
  const fmt = body.output_config?.format ?? body.output_format;
  const jsonSchema = fmt?.type === "json_schema" ? (fmt.schema ?? fmt.json_schema) : null;
  if (jsonSchema) ollamaReq.format = jsonSchema;

  const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ollamaReq),
    signal: ac?.signal,  // client disconnect aborts the Ollama call and frees the slot
  });

  if (!upstream.ok) {
    const detail = await upstream.text();
    const msg = `Ollama error (${upstream.status}): ${detail.slice(0, 500)}`;
    finish(rec, { status: "error", error: msg });
    return anthropicError(res, 502, "api_error", msg);
  }

  if (!body.stream) {
    const o = await upstream.json();
    const content = [];
    if (o.message?.thinking) content.push({ type: "thinking", thinking: o.message.thinking, signature: "" });
    if (o.message?.content) content.push({ type: "text", text: o.message.content });
    const toolCalls = o.message?.tool_calls || [];
    for (const tc of toolCalls) {
      content.push({ type: "tool_use", id: genId("toolu"), name: tc.function.name, input: tc.function.arguments || {} });
    }
    const stopReason = mapStopReason(o.done_reason, toolCalls.length > 0);
    const usage = {
      input_tokens: o.prompt_eval_count ?? inputTokens,
      output_tokens: o.eval_count ?? estimateTokens(o.message?.content || ""),
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    };
    if (o.message?.thinking) appendResponse(rec, `[thinking]\n${o.message.thinking}\n[/thinking]\n\n`);
    if (o.message?.content) appendResponse(rec, o.message.content);
    for (const tc of toolCalls) {
      appendResponse(rec, `\n[tool_use: ${tc.function.name} ${JSON.stringify(tc.function.arguments || {})}]`);
    }
    finish(rec, { status: "done", stopReason, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens });
    res.writeHead(200, { "content-type": "application/json", ...corsHeaders() });
    res.end(JSON.stringify({
      id: msgId, type: "message", role: "assistant", model: claudeModel,
      content, stop_reason: stopReason, stop_sequence: null, usage,
    }));
    return;
  }

  // Streaming: translate Ollama NDJSON -> Anthropic SSE
  const sse = new SSE(res);
  sse.send("message_start", messageStartPayload(msgId, claudeModel, inputTokens));

  let blockIndex = -1;
  let openBlock = null; // "thinking" | "text" | null
  let sawToolCall = false;
  let outputTokens = 0;
  let doneReason = "stop";
  let promptTokens = null;

  const openText = (type) => {
    blockIndex++;
    openBlock = type;
    sse.send("content_block_start", {
      type: "content_block_start", index: blockIndex,
      content_block: type === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" },
    });
  };
  const closeBlock = () => {
    if (openBlock) {
      sse.send("content_block_stop", { type: "content_block_stop", index: blockIndex });
      openBlock = null;
    }
  };

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let chunk;
        try { chunk = JSON.parse(line); } catch { continue; }

        if (chunk.message?.thinking) {
          if (openBlock !== "thinking") { closeBlock(); openText("thinking"); appendResponse(rec, "[thinking]\n"); }
          appendResponse(rec, chunk.message.thinking);
          sse.send("content_block_delta", {
            type: "content_block_delta", index: blockIndex,
            delta: { type: "thinking_delta", thinking: chunk.message.thinking },
          });
        }
        if (chunk.message?.content) {
          if (openBlock !== "text") {
            if (openBlock === "thinking") appendResponse(rec, "\n[/thinking]\n\n");
            closeBlock(); openText("text");
          }
          outputTokens++;
          rec.outputTokens = outputTokens;
          appendResponse(rec, chunk.message.content);
          tick(rec);
          sse.send("content_block_delta", {
            type: "content_block_delta", index: blockIndex,
            delta: { type: "text_delta", text: chunk.message.content },
          });
        }
        for (const tc of chunk.message?.tool_calls || []) {
          closeBlock();
          sawToolCall = true;
          blockIndex++;
          appendResponse(rec, `\n[tool_use: ${tc.function.name} ${JSON.stringify(tc.function.arguments || {})}]`);
          const toolId = genId("toolu");
          sse.send("content_block_start", {
            type: "content_block_start", index: blockIndex,
            content_block: { type: "tool_use", id: toolId, name: tc.function.name, input: {} },
          });
          sse.send("content_block_delta", {
            type: "content_block_delta", index: blockIndex,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(tc.function.arguments || {}) },
          });
          sse.send("content_block_stop", { type: "content_block_stop", index: blockIndex });
        }
        if (chunk.done) {
          doneReason = chunk.done_reason || "stop";
          if (chunk.eval_count) outputTokens = chunk.eval_count;
          if (chunk.prompt_eval_count) promptTokens = chunk.prompt_eval_count;
        }
      }
    }
  } catch (err) {
    if (!ac?.signal.aborted) log("stream error:", err.message);
  }
  // Canceled mid-stream: the socket is gone and the record is already finalized,
  // so don't write more SSE (would EPIPE) — just stop here.
  if (ac?.signal.aborted || res.writableEnded) return;
  closeBlock();
  const stopReason = mapStopReason(doneReason, sawToolCall);
  finish(rec, {
    status: "done", stopReason, outputTokens,
    ...(promptTokens != null ? { inputTokens: promptTokens } : {}),
  });
  sse.send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens, ...(promptTokens != null ? { input_tokens: promptTokens } : {}) },
  });
  sse.send("message_stop", { type: "message_stop" });
  sse.end();
}

// ---------------------------------------------------------------- mock mode

const MOCK_WORDS = ("the quick brown fox jumps over the lazy dog while testing " +
  "streaming responses from a mock model that costs zero tokens and returns " +
  "deterministic filler text for load and integration testing purposes").split(" ");

async function handleMock(res, body, claudeModel, msgId, inputTokens, rec, ac) {
  rec.ollamaModel = "mock";
  const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === "user");
  const preview = humanText(lastUser?.content).slice(0, 80);
  const intro = `[mock:${claudeModel}] Echoing your request ("${preview}"). `;
  const words = [intro, ...Array.from({ length: MOCK_TOKENS }, (_, i) => MOCK_WORDS[i % MOCK_WORDS.length] + " ")];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (!body.stream) {
    await sleep(MOCK_DELAY_MS * 5);
    const text = words.join("");
    appendResponse(rec, text);
    finish(rec, { status: "done", stopReason: "end_turn", outputTokens: words.length });
    res.writeHead(200, { "content-type": "application/json", ...corsHeaders() });
    res.end(JSON.stringify({
      id: msgId, type: "message", role: "assistant", model: claudeModel,
      content: [{ type: "text", text }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: words.length,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }));
    return;
  }

  const sse = new SSE(res);
  sse.send("message_start", messageStartPayload(msgId, claudeModel, inputTokens));
  sse.send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const w of words) {
    if (ac?.signal.aborted || res.writableEnded) return;  // client canceled mid-stream
    rec.outputTokens++;
    appendResponse(rec, w);
    tick(rec);
    sse.send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: w } });
    if (MOCK_DELAY_MS) await sleep(MOCK_DELAY_MS);
  }
  sse.send("content_block_stop", { type: "content_block_stop", index: 0 });
  finish(rec, { status: "done", stopReason: "end_turn", outputTokens: words.length });
  sse.send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: words.length },
  });
  sse.send("message_stop", { type: "message_stop" });
  sse.end();
}

// ---------------------------------------------------------------- models API

const ADVERTISED_MODELS = [
  "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5",
];

function modelObject(id) {
  return {
    type: "model", id, display_name: id,
    created_at: "2026-01-01T00:00:00Z",
    max_input_tokens: 200000, max_tokens: 64000,
  };
}

// ---------------------------------------------------------------- router

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  log(req.method, url.pathname);

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  try {
    if (req.method === "POST" && url.pathname === "/v1/messages") {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch {
        return anthropicError(res, 400, "invalid_request_error", "Invalid JSON body");
      }
      if (!body.model || !body.messages) {
        return anthropicError(res, 400, "invalid_request_error", "model and messages are required");
      }
      return await handleMessages(req, res, body);
    }

    if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      const body = JSON.parse(await readBody(req));
      res.writeHead(200, { "content-type": "application/json", ...corsHeaders() });
      return res.end(JSON.stringify({
        input_tokens: estimateTokens({ system: body.system, messages: body.messages, tools: body.tools }),
      }));
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json", ...corsHeaders() });
      return res.end(JSON.stringify({
        data: ADVERTISED_MODELS.map(modelObject),
        has_more: false, first_id: ADVERTISED_MODELS[0], last_id: ADVERTISED_MODELS.at(-1),
      }));
    }

    if (req.method === "GET" && url.pathname.startsWith("/v1/models/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/models/".length));
      res.writeHead(200, { "content-type": "application/json", ...corsHeaders() });
      return res.end(JSON.stringify(modelObject(id)));
    }

    if (req.method === "GET" && /^\/(logo|llama|favicon)\.(png|ico)$/.test(url.pathname)) {
      const img = path.join(path.dirname(DASHBOARD_HTML), "assets", path.basename(url.pathname));
      if (!fs.existsSync(img)) return anthropicError(res, 404, "not_found_error", "image not installed");
      res.writeHead(200, { "content-type": url.pathname.endsWith(".ico") ? "image/x-icon" : "image/png" });
      return res.end(fs.readFileSync(img));
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(DASHBOARD_HTML));
    }

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream", "cache-control": "no-cache",
        connection: "keep-alive", ...corsHeaders(),
      });
      res.write(`data: ${JSON.stringify({
        type: "snapshot",
        config: {
          mock: MOCK, ollama_url: OLLAMA_URL,
          default_model: defaultOllamaModel || process.env.OLLAMA_MODEL || null,
          model_map: MODEL_MAP,
        },
        records: activity.map(publicRec),
        totals,
      })}\n\n`);
      dashClients.add(res);
      req.on("close", () => dashClients.delete(res));
      return; // held open
    }

    if (req.method === "GET" && url.pathname.startsWith("/requests/")) {
      const id = url.pathname.slice("/requests/".length);
      const rec = activity.find((r) => r.id === id);
      if (!rec) return anthropicError(res, 404, "not_found_error", `No request ${id} in the activity buffer`);
      const { _start, _lastPush, ...full } = rec;
      res.writeHead(200, { "content-type": "application/json", ...corsHeaders() });
      return res.end(JSON.stringify(full));
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json", ...corsHeaders() });
      return res.end(JSON.stringify({
        ok: true, mode: MOCK ? "mock" : "ollama", ollama_url: OLLAMA_URL,
        default_model: defaultOllamaModel, model_map: MODEL_MAP,
      }));
    }

    return anthropicError(res, 404, "not_found_error", `No route for ${req.method} ${url.pathname}`);
  } catch (err) {
    const unreachable = err?.cause?.code === "ECONNREFUSED" || err?.message === "fetch failed";
    const msg = unreachable
      ? `Cannot reach Ollama at ${OLLAMA_URL} — is \`ollama serve\` running?`
      : String(err?.message || err);
    // Setup problems (ollama down / no model pulled) return 404 rather than 5xx:
    // clients retry 5xx with backoff, which looks like a hang instead of showing
    // the actionable message.
    const setupProblem = unreachable || msg.startsWith("No models installed");
    return anthropicError(res, setupProblem ? 404 : 500,
                          setupProblem ? "not_found_error" : "api_error", msg);
  }
});

// ------------------------------------------------------ keep the model warm & loaded
// Model load is the worst local-model latency, so we minimize how often it happens:
// keep_alive defaults to -1 (never idle-unload), AND we pre-load the model whenever
// Ollama becomes reachable — at shim launch and after any restart — with a tiny "hi".
async function warmOllama(model) {
  if (!model) return;
  try {
    await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model, messages: [{ role: "user", content: "hi" }],
        stream: false, keep_alive: KEEP_ALIVE, options: { num_predict: 1 },
      }),
    });
    console.log(`[fauxclaude] warmed ${model}`);
  } catch { /* model may not be installed yet — ignore, a real request will resolve one */ }
}

// The model to keep warm: whatever traffic last used, else the fast Haiku tier (the
// launcher default) — NOT the larger default model, so a small-RAM box only pins one.
async function warmTarget() {
  if (lastOllamaModel) return lastOllamaModel;
  try { return await resolveOllamaModel("claude-haiku-4-5"); } catch { return null; }
}

if (!MOCK) {
  let ollamaUp = null; // null = unknown
  const checkAndWarm = async () => {
    let up = false;
    try { up = (await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) })).ok; }
    catch { up = false; }
    // Warm when Ollama first appears up (launch) or comes back after being down (restart).
    if (up && ollamaUp !== true) {
      const model = await warmTarget();
      console.log(`[fauxclaude] Ollama up — warming ${model || "(no model)"}`);
      warmOllama(model);
    }
    ollamaUp = up;
  };
  checkAndWarm();                             // at launch
  setInterval(checkAndWarm, 4000).unref();    // and catch restarts
}

server.listen(PORT, () => {
  console.log(`[fauxclaude] FauxClaude listening on http://127.0.0.1:${PORT}`);
  console.log(`[fauxclaude] mode: ${MOCK ? "MOCK (no ollama)" : `passthrough -> ${OLLAMA_URL}`}`);
  console.log(`[fauxclaude] point clients at it with: ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} ANTHROPIC_API_KEY=sk-test`);
  console.log(`[fauxclaude] live dashboard: http://127.0.0.1:${PORT}/`);
});
