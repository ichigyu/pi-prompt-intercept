import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type Decision =
  | { action: "forward" }
  | { action: "forward-edited"; payload: unknown }
  | { action: "drop"; reason?: string }
  | { action: "timeout" };

type PendingRequest = {
  id: string;
  createdAt: number;
  cwd: string;
  model?: unknown;
  payload: unknown;
  status: "pending" | "forwarded" | "forwarded-edited" | "dropped" | "timeout" | "bypassed";
  resolve?: (decision: Decision) => void;
  timeout?: NodeJS.Timeout;
};

type RuntimeState = {
  enabled: boolean;
  interceptOnce: boolean;
  port: number;
  host: string;
  timeoutMs: number;
  startedAt: number;
  providerRequestCount: number;
  lastProviderRequestAt?: number;
  server?: Server;
  serverUrl?: string;
  requests: Map<string, PendingRequest>;
};

const state: RuntimeState = {
  enabled: process.env.PI_PROMPT_INTERCEPT !== "0",
  interceptOnce: process.env.PI_PROMPT_INTERCEPT_ONCE === "1",
  port: readIntEnv("PI_PROMPT_INTERCEPT_PORT", 47831),
  host: process.env.PI_PROMPT_INTERCEPT_HOST || "127.0.0.1",
  timeoutMs: readIntEnv("PI_PROMPT_INTERCEPT_TIMEOUT_MS", 10 * 60 * 1000),
  startedAt: Date.now(),
  providerRequestCount: 0,
  requests: new Map(),
};

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function modeLabel(): "on" | "off" | "once" {
  if (!state.enabled) return "off";
  return state.interceptOnce ? "once" : "on";
}

function setMode(mode: "on" | "off" | "once") {
  state.enabled = mode !== "off";
  state.interceptOnce = mode === "once";
}

function finishOnceMode() {
  if (!state.interceptOnce) return;
  state.enabled = false;
  state.interceptOnce = false;
}

function metadataFor(req: PendingRequest) {
  return {
    id: req.id,
    createdAt: req.createdAt,
    cwd: req.cwd,
    model: req.model,
    status: req.status,
  };
}

function writeAudit(ctx: ExtensionContext, event: Record<string, unknown>) {
  try {
    const dir = join(ctx.cwd, CONFIG_DIR_NAME, "prompt-intercept");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8");
  } catch {
    // Audit logging must never break provider requests.
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function settle(id: string, decision: Decision): boolean {
  const req = state.requests.get(id);
  if (!req || req.status !== "pending" || !req.resolve) return false;
  if (req.timeout) clearTimeout(req.timeout);
  if (decision.action === "forward") req.status = "forwarded";
  if (decision.action === "forward-edited") req.status = "forwarded-edited";
  if (decision.action === "drop") req.status = "dropped";
  if (decision.action === "timeout") req.status = "timeout";
  req.resolve(decision);
  return true;
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${state.host}:${state.port}`);

  if (req.method === "GET" && url.pathname === "/") {
    sendText(res, 200, html(), "text/html; charset=utf-8");
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, {
      enabled: state.enabled,
      interceptOnce: state.interceptOnce,
      mode: modeLabel(),
      serverUrl: state.serverUrl,
      startedAt: state.startedAt,
      providerRequestCount: state.providerRequestCount,
      lastProviderRequestAt: state.lastProviderRequestAt,
      pending: [...state.requests.values()].filter((r) => r.status === "pending").map(metadataFor),
      recent: [...state.requests.values()].slice(-50).reverse().map(metadataFor),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/enabled") {
    const body = (await readJsonBody(req)) as { enabled?: unknown; mode?: unknown } | undefined;
    if (body?.mode === "on" || body?.mode === "off" || body?.mode === "once") {
      setMode(body.mode);
    } else {
      setMode(body?.enabled === false ? "off" : "on");
    }
    sendJson(res, 200, { enabled: state.enabled, interceptOnce: state.interceptOnce, mode: modeLabel() });
    return;
  }

  const match = url.pathname.match(/^\/api\/requests\/([^/]+)(?:\/(forward|drop))?$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    const pending = state.requests.get(id);
    if (!pending) {
      sendJson(res, 404, { error: "request not found" });
      return;
    }

    if (req.method === "GET" && !action) {
      sendJson(res, 200, { ...metadataFor(pending), payload: pending.payload });
      return;
    }

    if (req.method === "POST" && action === "forward") {
      const body = (await readJsonBody(req)) as { payload?: unknown; edited?: unknown } | undefined;
      const ok = body?.edited === true
        ? settle(id, { action: "forward-edited", payload: body.payload })
        : settle(id, { action: "forward" });
      sendJson(res, ok ? 200 : 409, { ok });
      return;
    }

    if (req.method === "POST" && action === "drop") {
      const body = (await readJsonBody(req)) as { reason?: unknown } | undefined;
      const ok = settle(id, { action: "drop", reason: typeof body?.reason === "string" ? body.reason : undefined });
      sendJson(res, ok ? 200 : 409, { ok });
      return;
    }
  }

  sendJson(res, 404, { error: "not found" });
}

async function ensureServer(ctx: ExtensionContext): Promise<string> {
  if (state.serverUrl) return state.serverUrl;

  await new Promise<void>((resolve, reject) => {
    const server = createServer((req, res) => {
      route(req, res).catch((error) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }));
    });
    server.once("error", reject);
    server.listen(state.port, state.host, () => {
      state.server = server;
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : state.port;
      state.serverUrl = `http://${state.host}:${port}`;
      ctx.ui.notify(`Prompt intercept listening on ${state.serverUrl}`, "info");
      resolve();
    });
  });

  return state.serverUrl!;
}

function modelFor(ctx: ExtensionContext) {
  return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
}

function recordBypassed(ctx: ExtensionContext, payload: unknown): PendingRequest {
  const request: PendingRequest = {
    id: randomUUID(),
    createdAt: Date.now(),
    cwd: ctx.cwd,
    model: modelFor(ctx),
    payload,
    status: "bypassed",
  };
  state.requests.set(request.id, request);
  return request;
}

function intercept(ctx: ExtensionContext, payload: unknown): Promise<Decision> {
  const id = randomUUID();

  return new Promise<Decision>((resolve) => {
    const request: PendingRequest = {
      id,
      createdAt: Date.now(),
      cwd: ctx.cwd,
      model: modelFor(ctx),
      payload,
      status: "pending",
      resolve,
    };

    if (state.timeoutMs > 0) {
      request.timeout = setTimeout(() => {
        settle(id, { action: "timeout" });
      }, state.timeoutMs);
    }

    state.requests.set(id, request);
    const url = `${state.serverUrl}/#${id}`;
    ctx.ui.notify(`Provider request intercepted: ${url}`, "info");
    writeAudit(ctx, { event: "intercepted", request: metadataFor(request), url });
  });
}

function html(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>pi-prompt-intercept</title>
<style>
:root { color-scheme: light dark; --bg:#f4f5f7; --panel:#fff; --panel2:#f8fafc; --line:#dfe3ea; --text:#14171f; --muted:#687083; --blue:#2563eb; --green:#059669; --amber:#d97706; --red:#dc2626; --purple:#7c3aed; --cyan:#0891b2; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --panel:#161b22; --panel2:#1c2128; --line:#30363d; --text:#e6edf3; --muted:#8b949e; --blue:#58a6ff; --green:#3fb950; --amber:#d29922; --red:#f85149; --purple:#bc8cff; --cyan:#39d2c0; } }
* { box-sizing: border-box; }
body { margin: 0; height: 100vh; overflow: hidden; display: grid; grid-template-columns: 330px 1fr; background: var(--bg); color: var(--text); font-family: var(--sans); }
aside { border-right: 1px solid var(--line); background: var(--panel); display: grid; grid-template-rows: auto auto 1fr; min-width: 0; }
.brand { padding: 14px; border-bottom: 1px solid var(--line); }
.brand h1 { margin: 0 0 7px; font-size: 15px; letter-spacing: 0; }
.status-line { color: var(--muted); font-size: 12px; line-height: 1.45; }
.controls { padding: 10px 14px; border-bottom: 1px solid var(--line); display: flex; gap: 8px; flex-wrap: wrap; }
button { min-height: 32px; padding: 6px 11px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); cursor: pointer; font: inherit; font-size: 13px; }
button:hover { border-color: var(--blue); color: var(--blue); }
button.primary { background: var(--blue); border-color: var(--blue); color: white; }
button.danger { background: var(--red); border-color: var(--red); color: white; }
button:disabled { opacity: .45; cursor: not-allowed; }
#list { overflow: auto; padding: 10px; }
.item { border: 1px solid var(--line); border-radius: 8px; padding: 10px; margin-bottom: 8px; cursor: pointer; background: var(--panel); }
.item:hover { border-color: var(--blue); }
.item.pending { border-color: var(--blue); box-shadow: inset 3px 0 0 var(--blue); }
.item.active { outline: 2px solid var(--blue); }
.item .row { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 700; border: 1px solid var(--line); color: var(--muted); }
.badge.pending { color: var(--blue); border-color: var(--blue); }
.badge.dropped { color: var(--red); border-color: var(--red); }
.badge.bypassed { color: var(--green); border-color: var(--green); }
.item-id { font-family: var(--mono); font-size: 12px; color: var(--text); }
.meta { color: var(--muted); font-size: 11px; margin-top: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
main { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; }
.top { background: var(--panel); border-bottom: 1px solid var(--line); padding: 12px 16px; min-width: 0; }
#title { font-family: var(--mono); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#subtitle { color: var(--muted); font-size: 12px; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tabs { display: flex; gap: 4px; padding: 8px 16px; background: var(--panel); border-bottom: 1px solid var(--line); overflow-x: auto; }
.tab { min-height: 30px; padding: 5px 10px; border-radius: 6px; border: 1px solid transparent; color: var(--muted); background: transparent; font-size: 12px; }
.tab.active { color: var(--blue); border-color: var(--blue); background: color-mix(in srgb, var(--blue) 12%, transparent); }
#detail { min-height: 0; overflow: auto; padding: 14px 16px; }
.panel { display: none; }
.panel.active { display: block; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 12px; }
.card { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 10px; }
.card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; font-weight: 700; letter-spacing: .2px; }
.card .value { margin-top: 4px; font-family: var(--mono); font-size: 16px; font-weight: 700; overflow-wrap: anywhere; }
.section { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); margin-bottom: 10px; overflow: hidden; }
.section h2 { margin: 0; padding: 9px 12px; border-bottom: 1px solid var(--line); font-size: 13px; display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.section-body { padding: 12px; }
.pre, pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 12px; line-height: 1.55; background: var(--panel2); border: 1px solid var(--line); border-radius: 6px; padding: 10px; }
.empty { color: var(--muted); font-style: italic; }
.message { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 10px; background: var(--panel); }
.message.user { border-left: 4px solid var(--blue); }
.message.assistant { border-left: 4px solid var(--green); }
.message.system, .message.developer { border-left: 4px solid var(--amber); }
.message.tool { border-left: 4px solid var(--purple); }
.role { display: inline-flex; padding: 2px 8px; border-radius: 5px; font-size: 10px; font-weight: 800; text-transform: uppercase; color: white; background: var(--muted); margin-bottom: 8px; }
.message.user .role { background: var(--blue); }
.message.assistant .role { background: var(--green); }
.message.system .role, .message.developer .role { background: var(--amber); }
.message.tool .role { background: var(--purple); }
.block { margin-top: 8px; }
.block:first-child { margin-top: 0; }
.block-label { display: inline-flex; font-size: 11px; font-weight: 700; color: var(--cyan); background: color-mix(in srgb, var(--cyan) 12%, transparent); border: 1px solid color-mix(in srgb, var(--cyan) 45%, transparent); border-radius: 5px; padding: 2px 7px; margin-bottom: 5px; }
.tool { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); margin-bottom: 8px; overflow: hidden; }
.tool-head { padding: 9px 11px; border-bottom: 1px solid var(--line); display: flex; gap: 10px; align-items: baseline; }
.tool-name { font-family: var(--mono); color: var(--cyan); font-weight: 800; }
.tool-desc { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-body { padding: 10px 12px; }
.param { border-left: 2px solid var(--line); padding-left: 9px; margin: 7px 0; font-size: 12px; }
.param-name { font-family: var(--mono); color: var(--blue); font-weight: 700; }
.param-type { color: var(--amber); margin-left: 6px; }
#editor { width: 100%; height: calc(100vh - 250px); min-height: 360px; resize: vertical; border: 1px solid var(--line); border-radius: 8px; background: var(--panel2); color: var(--text); padding: 12px; font: 12px/1.5 var(--mono); tab-size: 2; }
footer { border-top: 1px solid var(--line); padding: 10px 16px; background: var(--panel); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
#message { color: var(--muted); font-size: 12px; }
.good { color: var(--green) !important; } .bad { color: var(--red) !important; }
.json-tree { font-family: var(--mono); font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
.jline { margin-left: 16px; }
.jkey { color: var(--purple); } .jstr { color: var(--green); } .jnum { color: var(--amber); } .jbool { color: var(--red); } .jnull { color: var(--muted); }
@media (max-width: 880px) { body { grid-template-columns: 1fr; grid-template-rows: 260px minmax(0, 1fr); } aside { border-right: 0; border-bottom: 1px solid var(--line); min-height: 0; } }
</style>
</head>
<body>
<aside>
  <div class="brand"><h1>pi-prompt-intercept</h1><div class="status-line" id="enabled"></div><div class="status-line" id="diagnostics">Local intercept UI for pi provider payloads.</div></div>
  <div class="controls"><button id="toggle"></button><button id="once">Intercept Once</button><button id="refresh">Refresh</button></div>
  <div id="list"></div>
</aside>
<main>
  <div class="top"><div id="title">No request selected</div><div id="subtitle"></div></div>
  <div class="tabs">
    <button class="tab active" data-tab="overview">Overview</button>
    <button class="tab" data-tab="system">System</button>
    <button class="tab" data-tab="messages">Messages</button>
    <button class="tab" data-tab="tools">Tools</button>
    <button class="tab" data-tab="raw">Edit JSON</button>
    <button class="tab" data-tab="tree">JSON Tree</button>
  </div>
  <div id="detail">
    <div id="overview" class="panel active"></div>
    <div id="system" class="panel"></div>
    <div id="messages" class="panel"></div>
    <div id="tools" class="panel"></div>
    <div id="raw" class="panel"><textarea id="editor" spellcheck="false" placeholder="Select a request..."></textarea></div>
    <div id="tree" class="panel"></div>
  </div>
  <footer>
    <button class="primary" id="forward">Forward</button>
    <button id="forwardEdited">Forward Edited</button>
    <button id="reset">Reset Edit</button>
    <button class="danger" id="drop">Drop</button>
    <button id="copy">Copy JSON</button>
    <span id="message"></span>
  </footer>
</main>
<script>
let currentId = location.hash ? location.hash.slice(1) : null;
let currentPayload = null;
let currentRequest = null;
let state = null;
const listEl = document.getElementById('list');
const editor = document.getElementById('editor');
const title = document.getElementById('title');
const subtitle = document.getElementById('subtitle');
const message = document.getElementById('message');
const enabled = document.getElementById('enabled');
const diagnostics = document.getElementById('diagnostics');
const toggle = document.getElementById('toggle');
const once = document.getElementById('once');
const refreshBtn = document.getElementById('refresh');
const forward = document.getElementById('forward');
const forwardEdited = document.getElementById('forwardEdited');
const reset = document.getElementById('reset');
const drop = document.getElementById('drop');
const copy = document.getElementById('copy');
const panels = [...document.querySelectorAll('.panel')];
const tabs = [...document.querySelectorAll('.tab')];
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function say(text, cls) { message.className = cls || ''; message.textContent = text; }
async function api(path, options) { const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options }); if (!res.ok) throw new Error(await res.text()); return res.json(); }
function bodyOf(payload) { return payload && typeof payload === 'object' && payload.request && typeof payload.request === 'object' ? payload.request : payload; }
function stringify(value) { try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) return content.map(part => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.input_text === 'string') return part.input_text;
    return stringify(part);
  }).filter(Boolean).join('\\n');
  return stringify(content);
}
function blocksFromContent(content) {
  if (content == null) return [];
  if (typeof content === 'string') return content.trim() ? [{ type:'text', text:content }] : [];
  if (Array.isArray(content)) return content.map(v => typeof v === 'string' ? { type:'text', text:v } : v).filter(Boolean);
  return [content];
}
function isInstructionRole(role) { return role === 'system' || role === 'developer'; }
function geminiRequest(body) { if (body && typeof body === 'object' && body.request && (Array.isArray(body.request.contents) || body.request.systemInstruction)) return body.request; return body || {}; }
function geminiText(parts) { return Array.isArray(parts) ? parts.map(p => p && typeof p.text === 'string' ? p.text : '').filter(Boolean).join('\\n') : ''; }
function extractSystem(body) {
  const parts = [];
  if (!body || typeof body !== 'object') return '';
  if (typeof body.system === 'string') parts.push(body.system);
  if (Array.isArray(body.system)) parts.push(textFromContent(body.system));
  if (typeof body.instructions === 'string') parts.push(body.instructions);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) if (m && isInstructionRole(m.role)) parts.push(textFromContent(m.content));
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) if (item && typeof item === 'object' && isInstructionRole(item.role)) parts.push(textFromContent(item.content));
  }
  const g = geminiRequest(body);
  if (g.systemInstruction) parts.push(geminiText(g.systemInstruction.parts));
  return parts.filter(s => String(s).trim()).join('\\n\\n');
}
function normalizeToolCall(call) {
  const fn = call && call.function ? call.function : {};
  let input = fn.arguments ?? call.arguments ?? call.input ?? {};
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch {} }
  return { type:'tool_use', id: call.id || call.call_id || '', name: fn.name || call.name || call.type || 'tool_use', input };
}
function normalizeMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (isInstructionRole(msg.role)) return null;
  const role = msg.role || 'unknown';
  const content = [];
  if (role === 'tool') content.push({ type:'tool_result', tool_use_id: msg.tool_call_id || '', content: msg.content || '' });
  else content.push(...blocksFromContent(msg.content));
  if (Array.isArray(msg.tool_calls)) content.push(...msg.tool_calls.map(normalizeToolCall));
  return { role, content };
}
function geminiMessages(body) {
  const g = geminiRequest(body);
  if (!Array.isArray(g.contents)) return [];
  return g.contents.map(item => {
    const blocks = [];
    for (const part of item.parts || []) {
      if (typeof part.text === 'string') blocks.push({ type: part.thought ? 'thinking' : 'text', text: part.text, thinking: part.text });
      if (part.functionCall) blocks.push({ type:'tool_use', id: part.functionCall.id || '', name: part.functionCall.name || 'tool_use', input: part.functionCall.args || {} });
      if (part.functionResponse) blocks.push({ type:'tool_result', tool_use_id: part.functionResponse.id || part.functionResponse.name || '', content: stringify(part.functionResponse.response || {}) });
    }
    return blocks.length ? { role: item.role === 'model' ? 'assistant' : (item.role || 'user'), content: blocks } : null;
  }).filter(Boolean);
}
function extractMessages(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.messages)) return body.messages.map(normalizeMessage).filter(Boolean);
  if (Array.isArray(geminiRequest(body).contents)) return geminiMessages(body);
  if (Array.isArray(body.input)) {
    return body.input.filter(i => i && typeof i === 'object' && i.role && !isInstructionRole(i.role)).map(i => ({ role: i.role, content: blocksFromContent(i.content || i) }));
  }
  return [];
}
function flattenGeminiTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const group of tools) for (const decl of group.functionDeclarations || []) out.push({ name: decl.name, description: decl.description || '', input_schema: decl.parametersJsonSchema || decl.parameters || {} });
  return out;
}
function extractTools(body) {
  if (!body || typeof body !== 'object') return [];
  const gtools = flattenGeminiTools(geminiRequest(body).tools);
  if (gtools.length) return gtools;
  return Array.isArray(body.tools) ? body.tools : [];
}
function toolName(tool) { return tool.name || tool.function?.name || tool.custom?.name || tool.type || 'tool'; }
function toolDesc(tool) { return tool.description || tool.function?.description || tool.custom?.description || ''; }
function toolSchema(tool) { return tool.input_schema || tool.parameters || tool.function?.parameters || tool.custom?.input_schema || {}; }
function renderContent(content) {
  const blocks = blocksFromContent(content);
  if (!blocks.length) return '<div class="empty">empty</div>';
  return blocks.map(block => {
    if (!block || typeof block !== 'object') return '<div class="pre">' + esc(block) + '</div>';
    if (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') return '<div class="block"><div class="pre">' + esc(block.text || '') + '</div></div>';
    if (block.type === 'thinking') return '<div class="block"><span class="block-label">thinking</span><div class="pre">' + esc(block.thinking || block.text || '') + '</div></div>';
    if (block.type === 'tool_use') return '<div class="block"><span class="block-label">tool_use: ' + esc(block.name || '') + '</span><pre>' + esc(stringify(block.input || {})) + '</pre></div>';
    if (block.type === 'tool_result') return '<div class="block"><span class="block-label">tool_result: ' + esc(block.tool_use_id || '') + '</span><div class="pre">' + esc(textFromContent(block.content)) + '</div></div>';
    if (block.type === 'image' || block.type === 'input_image') return '<div class="block"><span class="block-label">image</span><pre>' + esc(stringify(block)) + '</pre></div>';
    return '<div class="block"><pre>' + esc(stringify(block)) + '</pre></div>';
  }).join('');
}
function renderMessages(messages) {
  if (!messages.length) return '<div class="empty">No messages found in this provider payload.</div>';
  return messages.map(m => '<div class="message ' + esc(m.role) + '"><div class="role">' + esc(m.role) + '</div>' + renderContent(m.content) + '</div>').join('');
}
function renderTools(tools) {
  if (!tools.length) return '<div class="empty">No tools found in this provider payload.</div>';
  return tools.map(tool => {
    const schema = toolSchema(tool) || {};
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    const params = Object.keys(props).map(k => '<div class="param"><span class="param-name">' + esc(k) + '</span><span class="param-type">' + esc(props[k].type || (props[k].enum ? 'enum' : '')) + '</span>' + (required.has(k) ? '<span class="badge">required</span>' : '') + '<div>' + esc(props[k].description || '') + '</div></div>').join('');
    return '<div class="tool"><div class="tool-head"><span class="tool-name">' + esc(toolName(tool)) + '</span><span class="tool-desc">' + esc(toolDesc(tool).split('\\n')[0]) + '</span></div><div class="tool-body">' + (toolDesc(tool) ? '<div class="pre">' + esc(toolDesc(tool)) + '</div>' : '') + (params || '<pre>' + esc(stringify(schema)) + '</pre>') + '</div></div>';
  }).join('');
}
function jsonTree(value) {
  if (value === null) return '<span class="jnull">null</span>';
  if (typeof value === 'string') return '<span class="jstr">' + esc(JSON.stringify(value)) + '</span>';
  if (typeof value === 'number') return '<span class="jnum">' + value + '</span>';
  if (typeof value === 'boolean') return '<span class="jbool">' + value + '</span>';
  if (!value || typeof value !== 'object') return esc(String(value));
  const isArr = Array.isArray(value);
  const keys = isArr ? value.map((_, i) => i) : Object.keys(value);
  if (!keys.length) return isArr ? '[]' : '{}';
  return (isArr ? '[' : '{') + keys.map(k => '<div class="jline">' + (isArr ? '' : '<span class="jkey">' + esc(JSON.stringify(k)) + '</span>: ') + jsonTree(value[k]) + '</div>').join('') + (isArr ? ']' : '}');
}
function renderReadable(req) {
  const body = bodyOf(req.payload);
  const raw = stringify(req.payload);
  const system = extractSystem(body);
  const messages = extractMessages(body);
  const tools = extractTools(body);
  const model = body?.model || req.model?.id || '';
  const params = Object.entries(body || {}).filter(([k, v]) => !['messages','input','system','instructions','tools','contents','systemInstruction'].includes(k) && (typeof v !== 'object' || v === null)).map(([k,v]) => [k, v]);
  document.getElementById('overview').innerHTML = '<div class="cards">'
    + '<div class="card"><div class="label">model</div><div class="value">' + esc(model || 'unknown') + '</div></div>'
    + '<div class="card"><div class="label">messages</div><div class="value">' + messages.length + '</div></div>'
    + '<div class="card"><div class="label">tools</div><div class="value">' + tools.length + '</div></div>'
    + '<div class="card"><div class="label">approx tokens</div><div class="value">' + Math.ceil(raw.length / 4).toLocaleString() + '</div></div>'
    + '</div><div class="section"><h2>Request Parameters</h2><div class="section-body">' + (params.length ? '<pre>' + esc(params.map(([k,v]) => k + ': ' + stringify(v)).join('\\n')) + '</pre>' : '<div class="empty">No scalar request parameters found.</div>') + '</div></div>'
    + '<div class="section"><h2>System Preview <span class="badge">' + system.length.toLocaleString() + ' chars</span></h2><div class="section-body"><div class="pre">' + esc(system.slice(0, 5000) || 'No system prompt found.') + (system.length > 5000 ? '\\n\\n... truncated in overview; open System tab for full text.' : '') + '</div></div></div>';
  document.getElementById('system').innerHTML = '<div class="section"><h2>System Prompt <span class="badge">' + system.length.toLocaleString() + ' chars</span></h2><div class="section-body"><div class="pre">' + esc(system || 'No system prompt found.') + '</div></div></div>';
  document.getElementById('messages').innerHTML = renderMessages(messages);
  document.getElementById('tools').innerHTML = renderTools(tools);
  document.getElementById('tree').innerHTML = '<div class="section"><h2>JSON Tree</h2><div class="section-body json-tree">' + jsonTree(req.payload) + '</div></div>';
}
function renderList() {
  const items = [...(state?.pending || []), ...(state?.recent || []).filter(r => !(state?.pending || []).some(p => p.id === r.id))];
  listEl.innerHTML = '';
  if (!items.length) {
    listEl.innerHTML = '<div class="empty">No provider requests captured yet.<br><br>Check that pi was started with this extension loaded, then send a prompt that reaches the model. If installed as a package after a git push, run pi update or reload the extension.</div>';
    return;
  }
  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'item ' + item.status + (item.id === currentId ? ' active' : '');
    div.innerHTML = '<div class="row"><span class="item-id">' + item.id.slice(0, 8) + '</span><span class="badge ' + item.status + '">' + item.status + '</span></div><div class="meta">' + new Date(item.createdAt).toLocaleTimeString() + ' / ' + (item.model?.provider || '') + '/' + (item.model?.id || '') + '</div><div class="meta">' + esc(item.cwd || '') + '</div>';
    div.onclick = () => select(item.id);
    listEl.appendChild(div);
  }
}
async function refresh() {
  state = await api('/api/state');
  enabled.textContent = 'Mode: ' + (state.mode || (state.enabled ? 'on' : 'off'));
  enabled.className = 'status-line ' + (state.enabled ? 'good' : 'bad');
  diagnostics.textContent = 'Requests seen: ' + (state.providerRequestCount || 0) + ' / started ' + (state.startedAt ? new Date(state.startedAt).toLocaleTimeString() : 'unknown') + (state.lastProviderRequestAt ? ' / last ' + new Date(state.lastProviderRequestAt).toLocaleTimeString() : '');
  toggle.textContent = state.enabled ? 'Disable' : 'Enable';
  once.disabled = state.mode === 'once';
  renderList();
  const items = [...(state?.pending || []), ...(state?.recent || []).filter(r => !(state?.pending || []).some(p => p.id === r.id))];
  const currentSummary = items.find(item => item.id === currentId);
  if (currentRequest && currentSummary) {
    currentRequest.status = currentSummary.status;
    subtitle.textContent = currentRequest.status + ' / ' + new Date(currentRequest.createdAt).toLocaleString() + ' / ' + currentRequest.cwd;
  }
  updateActions();
  if (currentId && !currentRequest && items.some(item => item.id === currentId)) {
    select(currentId);
  } else if ((!currentId || !items.some(item => item.id === currentId)) && state.pending?.[0]) {
    select(state.pending[0].id);
  }
}
function updateActions() {
  const hasRequest = !!currentRequest;
  const canDecide = currentRequest?.status === 'pending';
  forward.disabled = !canDecide;
  forwardEdited.disabled = !canDecide;
  drop.disabled = !canDecide;
  reset.disabled = !hasRequest;
  copy.disabled = !hasRequest;
}
async function select(id) {
  currentId = id;
  history.replaceState(null, '', '#' + id);
  const req = await api('/api/requests/' + encodeURIComponent(id));
  currentRequest = req;
  currentPayload = req.payload;
  editor.value = stringify(req.payload);
  title.textContent = req.id;
  subtitle.textContent = req.status + ' / ' + new Date(req.createdAt).toLocaleString() + ' / ' + req.cwd;
  renderReadable(req);
  updateActions();
  say('');
  renderList();
}
async function postDecision(path, body) {
  if (!currentId) return;
  await api('/api/requests/' + encodeURIComponent(currentId) + path, { method: 'POST', body: JSON.stringify(body || {}) });
  say('sent', 'good');
  await refresh();
}
for (const tab of tabs) tab.onclick = () => { tabs.forEach(t => t.classList.remove('active')); panels.forEach(p => p.classList.remove('active')); tab.classList.add('active'); document.getElementById(tab.dataset.tab).classList.add('active'); };
forward.onclick = () => postDecision('/forward', { edited: false });
forwardEdited.onclick = async () => { try { await postDecision('/forward', { edited: true, payload: JSON.parse(editor.value) }); } catch (e) { say('Invalid JSON: ' + e.message, 'bad'); } };
reset.onclick = () => { if (currentPayload !== null) editor.value = stringify(currentPayload); };
drop.onclick = () => postDecision('/drop', { reason: 'Dropped in pi-prompt-intercept UI' });
copy.onclick = async () => { await navigator.clipboard.writeText(editor.value); say('copied', 'good'); };
toggle.onclick = async () => { await api('/api/enabled', { method: 'POST', body: JSON.stringify({ mode: state.enabled ? 'off' : 'on' }) }); await refresh(); };
once.onclick = async () => { await api('/api/enabled', { method: 'POST', body: JSON.stringify({ mode: 'once' }) }); await refresh(); };
refreshBtn.onclick = () => refresh().catch(e => say(e.message, 'bad'));
updateActions();
window.addEventListener('hashchange', () => { if (location.hash) select(location.hash.slice(1)); });
setInterval(refresh, 1000);
refresh().catch(e => say(e.message, 'bad'));
</script>
</body>
</html>`;
}

export default function promptIntercept(pi: ExtensionAPI) {
  pi.registerCommand("prompt-intercept-on", {
    description: "Enable provider payload interception for every request",
    handler: async (_args, ctx) => {
      setMode("on");
      ctx.ui.notify("Prompt intercept mode: on", "info");
    },
  });

  pi.registerCommand("prompt-intercept-off", {
    description: "Disable provider payload interception",
    handler: async (_args, ctx) => {
      setMode("off");
      ctx.ui.notify("Prompt intercept mode: off", "info");
    },
  });

  pi.registerCommand("prompt-intercept-once", {
    description: "Intercept only the next provider request, then disable interception",
    handler: async (_args, ctx) => {
      setMode("once");
      ctx.ui.notify("Prompt intercept mode: once", "info");
    },
  });

  pi.registerCommand("prompt-intercept-status", {
    description: "Show prompt intercept mode and local UI URL",
    handler: async (_args, ctx) => {
      const serverUrl = state.serverUrl ?? await ensureServer(ctx);
      ctx.ui.notify(`Prompt intercept mode: ${modeLabel()} (${serverUrl})`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const serverUrl = await ensureServer(ctx);
      ctx.ui.setStatus("prompt-intercept", `intercept: ${modeLabel()} ${serverUrl}`);
    } catch (error) {
      ctx.ui.notify(`Prompt intercept failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  pi.on("before_provider_request", async (event, ctx) => {
    state.providerRequestCount += 1;
    state.lastProviderRequestAt = Date.now();

    const serverUrl = await ensureServer(ctx);

    if (!state.enabled) {
      const request = recordBypassed(ctx, event.payload);
      writeAudit(ctx, { event: "bypassed", request: metadataFor(request), url: `${serverUrl}/#${request.id}` });
      return;
    }

    const decision = await intercept(ctx, event.payload);

    if (decision.action === "forward") {
      writeAudit(ctx, { event: "forwarded", action: decision.action });
      finishOnceMode();
      return;
    }

    if (decision.action === "forward-edited") {
      writeAudit(ctx, { event: "forwarded-edited", action: decision.action });
      finishOnceMode();
      return decision.payload;
    }

    if (decision.action === "timeout") {
      writeAudit(ctx, { event: "timeout", action: "forward", serverUrl });
      ctx.ui.notify("Prompt intercept timed out; forwarding original payload", "warning");
      finishOnceMode();
      return;
    }

    writeAudit(ctx, { event: "dropped", reason: decision.reason });
    finishOnceMode();
    throw new Error(decision.reason || "Provider request dropped by pi-prompt-intercept");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    for (const req of state.requests.values()) {
      if (req.status === "pending") settle(req.id, { action: "drop", reason: "Session shutting down" });
    }
    if (state.server) {
      await new Promise<void>((resolve) => state.server?.close(() => resolve()));
      state.server = undefined;
      state.serverUrl = undefined;
    }
    ctx.ui.setStatus("prompt-intercept", undefined);
  });
}
