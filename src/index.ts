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
  status: "pending" | "forwarded" | "forwarded-edited" | "dropped" | "timeout";
  resolve: (decision: Decision) => void;
  timeout?: NodeJS.Timeout;
};

type RuntimeState = {
  enabled: boolean;
  port: number;
  host: string;
  timeoutMs: number;
  server?: Server;
  serverUrl?: string;
  requests: Map<string, PendingRequest>;
};

const state: RuntimeState = {
  enabled: process.env.PI_PROMPT_INTERCEPT !== "0",
  port: readIntEnv("PI_PROMPT_INTERCEPT_PORT", 47831),
  host: process.env.PI_PROMPT_INTERCEPT_HOST || "127.0.0.1",
  timeoutMs: readIntEnv("PI_PROMPT_INTERCEPT_TIMEOUT_MS", 10 * 60 * 1000),
  requests: new Map(),
};

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
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
  if (!req || req.status !== "pending") return false;
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
      serverUrl: state.serverUrl,
      pending: [...state.requests.values()].filter((r) => r.status === "pending").map(metadataFor),
      recent: [...state.requests.values()].slice(-50).reverse().map(metadataFor),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/enabled") {
    const body = (await readJsonBody(req)) as { enabled?: unknown } | undefined;
    state.enabled = body?.enabled !== false;
    sendJson(res, 200, { enabled: state.enabled });
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

function intercept(ctx: ExtensionContext, payload: unknown): Promise<Decision> {
  const id = randomUUID();
  const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;

  return new Promise<Decision>((resolve) => {
    const request: PendingRequest = {
      id,
      createdAt: Date.now(),
      cwd: ctx.cwd,
      model,
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
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; display: grid; grid-template-columns: 320px 1fr; height: 100vh; }
aside { border-right: 1px solid #7775; overflow: auto; padding: 12px; }
main { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; }
header, footer { padding: 12px; border-bottom: 1px solid #7775; }
footer { border-top: 1px solid #7775; border-bottom: 0; display: flex; gap: 8px; flex-wrap: wrap; }
button { padding: 7px 10px; border: 1px solid #7778; border-radius: 6px; background: transparent; cursor: pointer; }
button.primary { background: #2563eb; color: white; border-color: #2563eb; }
button.danger { background: #dc2626; color: white; border-color: #dc2626; }
button:disabled { opacity: .5; cursor: not-allowed; }
.item { border: 1px solid #7775; border-radius: 6px; padding: 9px; margin-bottom: 8px; cursor: pointer; }
.item.pending { border-color: #2563eb; }
.item.active { outline: 2px solid #2563eb; }
.meta { color: #777; font-size: 12px; margin-top: 4px; }
#editor { width: 100%; height: 100%; box-sizing: border-box; resize: none; border: 0; padding: 12px; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size: 2; }
.status { font-size: 13px; color: #777; }
.bad { color: #dc2626; }
.good { color: #16a34a; }
</style>
</head>
<body>
<aside>
  <h2>pi-prompt-intercept</h2>
  <p class="status" id="enabled"></p>
  <button id="toggle"></button>
  <h3>Requests</h3>
  <div id="list"></div>
</aside>
<main>
  <header>
    <div id="title">No request selected</div>
    <div class="status" id="status"></div>
  </header>
  <textarea id="editor" spellcheck="false" placeholder="Select an intercepted provider payload..."></textarea>
  <footer>
    <button class="primary" id="forward">Forward</button>
    <button id="forwardEdited">Forward Edited</button>
    <button id="reset">Reset</button>
    <button class="danger" id="drop">Drop</button>
    <button id="copy">Copy</button>
    <span class="status" id="message"></span>
  </footer>
</main>
<script>
let currentId = location.hash ? location.hash.slice(1) : null;
let currentPayload = null;
let state = null;
const listEl = document.getElementById('list');
const editor = document.getElementById('editor');
const title = document.getElementById('title');
const statusEl = document.getElementById('status');
const message = document.getElementById('message');
const enabled = document.getElementById('enabled');
const toggle = document.getElementById('toggle');
const forward = document.getElementById('forward');
const forwardEdited = document.getElementById('forwardEdited');
const reset = document.getElementById('reset');
const drop = document.getElementById('drop');
const copy = document.getElementById('copy');
function say(text, cls='') { message.className = 'status ' + cls; message.textContent = text; }
async function api(path, options) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
function renderList() {
  const items = [...(state?.pending || []), ...(state?.recent || []).filter(r => !(state?.pending || []).some(p => p.id === r.id))];
  listEl.innerHTML = '';
  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'item ' + item.status + (item.id === currentId ? ' active' : '');
    div.innerHTML = '<strong>' + item.status + '</strong><div>' + item.id.slice(0, 8) + '</div><div class="meta">' + new Date(item.createdAt).toLocaleTimeString() + ' · ' + (item.model?.provider || '') + '/' + (item.model?.id || '') + '</div>';
    div.onclick = () => select(item.id);
    listEl.appendChild(div);
  }
}
async function refresh() {
  state = await api('/api/state');
  enabled.textContent = state.enabled ? 'Intercept enabled' : 'Intercept disabled';
  enabled.className = 'status ' + (state.enabled ? 'good' : 'bad');
  toggle.textContent = state.enabled ? 'Disable' : 'Enable';
  renderList();
  if (!currentId && state.pending?.[0]) select(state.pending[0].id);
}
async function select(id) {
  currentId = id;
  history.replaceState(null, '', '#' + id);
  const req = await api('/api/requests/' + encodeURIComponent(id));
  currentPayload = req.payload;
  editor.value = JSON.stringify(req.payload, null, 2);
  title.textContent = req.id;
  statusEl.textContent = req.status + ' · ' + new Date(req.createdAt).toLocaleString() + ' · ' + req.cwd;
  say('');
  renderList();
}
async function postDecision(path, body) {
  if (!currentId) return;
  await api('/api/requests/' + encodeURIComponent(currentId) + path, { method: 'POST', body: JSON.stringify(body || {}) });
  say('sent', 'good');
  await refresh();
}
forward.onclick = () => postDecision('/forward', { edited: false });
forwardEdited.onclick = async () => {
  try { await postDecision('/forward', { edited: true, payload: JSON.parse(editor.value) }); }
  catch (e) { say('Invalid JSON: ' + e.message, 'bad'); }
};
reset.onclick = () => { if (currentPayload !== null) editor.value = JSON.stringify(currentPayload, null, 2); };
drop.onclick = () => postDecision('/drop', { reason: 'Dropped in pi-prompt-intercept UI' });
copy.onclick = async () => { await navigator.clipboard.writeText(editor.value); say('copied', 'good'); };
toggle.onclick = async () => { await api('/api/enabled', { method: 'POST', body: JSON.stringify({ enabled: !state.enabled }) }); await refresh(); };
window.addEventListener('hashchange', () => { if (location.hash) select(location.hash.slice(1)); });
setInterval(refresh, 1000);
refresh().catch(e => say(e.message, 'bad'));
</script>
</body>
</html>`;
}

export default function promptIntercept(pi: ExtensionAPI) {
  pi.on("before_provider_request", async (event, ctx) => {
    if (!state.enabled) return;

    const serverUrl = await ensureServer(ctx);
    const decision = await intercept(ctx, event.payload);

    if (decision.action === "forward") {
      writeAudit(ctx, { event: "forwarded", action: decision.action });
      return;
    }

    if (decision.action === "forward-edited") {
      writeAudit(ctx, { event: "forwarded-edited", action: decision.action });
      return decision.payload;
    }

    if (decision.action === "timeout") {
      writeAudit(ctx, { event: "timeout", action: "forward", serverUrl });
      ctx.ui.notify("Prompt intercept timed out; forwarding original payload", "warning");
      return;
    }

    writeAudit(ctx, { event: "dropped", reason: decision.reason });
    throw new Error(decision.reason || "Provider request dropped by pi-prompt-intercept");
  });

  pi.on("session_shutdown", async () => {
    for (const req of state.requests.values()) {
      if (req.status === "pending") settle(req.id, { action: "drop", reason: "Session shutting down" });
    }
    if (state.server) {
      await new Promise<void>((resolve) => state.server?.close(() => resolve()));
      state.server = undefined;
      state.serverUrl = undefined;
    }
  });
}
