#!/usr/bin/env node
// ollama-claude-shim — pretends to be the Anthropic Messages API, backed by a
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
import path from "node:path";
import { fileURLToPath } from "node:url";

const DASHBOARD_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard.html");

const PORT = Number(process.env.PORT || 11435);
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/$/, "");
const MOCK = process.env.MOCK === "1";
const MOCK_DELAY_MS = Number(process.env.MOCK_DELAY_MS || 15);
const MOCK_TOKENS = Number(process.env.MOCK_TOKENS || 60);
const LOG = process.env.LOG === "1";
const NUM_CTX = Number(process.env.NUM_CTX || 32768);
const KEEP_ALIVE = process.env.KEEP_ALIVE || "30m";
const MODEL_MAP = (() => {
  try { return JSON.parse(process.env.MODEL_MAP || "{}"); } catch { return {}; }
})();

let defaultOllamaModel = process.env.OLLAMA_MODEL || null;

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
  if (MODEL_MAP[claudeModel]) return MODEL_MAP[claudeModel];
  if (process.env.OLLAMA_MODEL) return process.env.OLLAMA_MODEL;
  // Re-resolve on every request (~1ms against localhost) so pulling/deleting
  // models in Ollama takes effect without restarting the shim.
  const resp = await fetch(`${OLLAMA_URL}/api/tags`);
  const tags = await resp.json();
  if (!tags.models?.length) throw new Error("No models installed in Ollama — run `ollama pull <model>`");
  const picked = tags.models[0].name;
  if (picked !== defaultOllamaModel) {
    defaultOllamaModel = picked;
    console.log(`[shim] defaulting to ollama model: ${picked}`);
  }
  return picked;
}

// ------------------------------------------------------- activity feed (GUI)

const activity = [];            // capped ring buffer of request records
const dashClients = new Set();  // open /events SSE responses
const MAX_ACTIVITY = 200;

const publicRec = ({ _start, _lastPush, ...pub }) => pub;

function broadcast(rec) {
  const line = `data: ${JSON.stringify({ type: "update", record: publicRec(rec) })}\n\n`;
  for (const client of dashClients) client.write(line);
}

function track(body, inputTokens) {
  const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === "user");
  const rec = {
    id: genId("act"), ts: Date.now(), model: body.model, ollamaModel: null,
    stream: !!body.stream, status: "active", inputTokens, outputTokens: 0,
    durationMs: null, stopReason: null, error: null,
    preview: blockText(lastUser?.content ?? "").replace(/\s+/g, " ").slice(0, 200),
    _start: Date.now(), _lastPush: 0,
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
  Object.assign(rec, fields, { durationMs: Date.now() - rec._start });
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

  try {
    if (MOCK) return await handleMock(res, body, claudeModel, msgId, inputTokens, rec);
    return await handleOllama(res, body, claudeModel, msgId, inputTokens, rec);
  } catch (err) {
    const msg = err?.cause?.code === "ECONNREFUSED" || err?.message === "fetch failed"
      ? `Cannot reach Ollama at ${OLLAMA_URL} — is \`ollama serve\` running?`
      : String(err?.message || err);
    finish(rec, { status: "error", error: msg });
    throw err;
  }
}

async function handleOllama(res, body, claudeModel, msgId, inputTokens, rec) {
  const ollamaModel = await resolveOllamaModel(claudeModel);
  rec.ollamaModel = ollamaModel;
  const ollamaReq = {
    model: ollamaModel,
    messages: anthropicToOllamaMessages(body),
    tools: anthropicToolsToOllama(body.tools),
    stream: !!body.stream,
    keep_alive: KEEP_ALIVE,
    options: { num_ctx: NUM_CTX },
  };
  if (body.max_tokens) ollamaReq.options.num_predict = body.max_tokens;
  if (body.temperature != null) ollamaReq.options.temperature = body.temperature;
  if (body.top_p != null) ollamaReq.options.top_p = body.top_p;
  if (body.stop_sequences?.length) ollamaReq.options.stop = body.stop_sequences;

  const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ollamaReq),
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
          if (openBlock !== "thinking") { closeBlock(); openText("thinking"); }
          sse.send("content_block_delta", {
            type: "content_block_delta", index: blockIndex,
            delta: { type: "thinking_delta", thinking: chunk.message.thinking },
          });
        }
        if (chunk.message?.content) {
          if (openBlock !== "text") { closeBlock(); openText("text"); }
          outputTokens++;
          rec.outputTokens = outputTokens;
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
    log("stream error:", err.message);
  }
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

async function handleMock(res, body, claudeModel, msgId, inputTokens, rec) {
  rec.ollamaModel = "mock";
  const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === "user");
  const preview = blockText(lastUser?.content ?? "").slice(0, 80);
  const intro = `[mock:${claudeModel}] Echoing your request ("${preview}"). `;
  const words = [intro, ...Array.from({ length: MOCK_TOKENS }, (_, i) => MOCK_WORDS[i % MOCK_WORDS.length] + " ")];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (!body.stream) {
    await sleep(MOCK_DELAY_MS * 5);
    const text = words.join("");
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
    rec.outputTokens++;
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
      })}\n\n`);
      dashClients.add(res);
      req.on("close", () => dashClients.delete(res));
      return; // held open
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

server.listen(PORT, () => {
  console.log(`[shim] Claude API shim listening on http://127.0.0.1:${PORT}`);
  console.log(`[shim] mode: ${MOCK ? "MOCK (no ollama)" : `passthrough -> ${OLLAMA_URL}`}`);
  console.log(`[shim] point clients at it with: ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} ANTHROPIC_API_KEY=sk-test`);
  console.log(`[shim] live dashboard: http://127.0.0.1:${PORT}/`);
});
