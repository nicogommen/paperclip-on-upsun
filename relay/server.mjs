// runner-relay: a WebSocket tunnel so Paperclip can "dial into" a Paperclip Runner that
// lives in an Upsun task, which accepts no inbound connections.
//
//   Paperclip Core --wss--> relay /t/<tunnelId>/<path>   (Core-facing, the plugin's `connection` URL)
//   task shim      --wss--> relay /tunnel/<tunnelId>     (control channel, opened by the task)
//   task shim      --wss--> relay /data/<connId>         (one data channel per Core connection)
//
// For each Core connection the relay tells the shim to open a data channel, and the shim
// opens a matching local WebSocket to the runner at <path>, forwarding Core's headers.
// Messages are piped as-is (text/binary preserved). Every channel needs the tunnel's
// secret in the `x-relay-token` header. Nothing is persisted.

import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const PING_MS = 20_000;
const DATA_WAIT_MS = 15_000;
const ID = /^[A-Za-z0-9_-]{8,128}$/;

// Headers that belong to this hop's handshake, not to the runner.
const DROP = new Set([
  "host", "connection", "upgrade", "content-length", "transfer-encoding",
  "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions",
  "x-relay-token", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host",
  "x-client-ip", "x-real-ip", "via",
  // Added by the Upsun router on the way in. Not Core's, so not the runner's business.
  "client-abuse-score", "client-asn", "client-country", "x-client-ssl", "x-client-verify",
  "x-original-route", "traceparent", "tracestate", "accept-encoding",
]);

const tunnels = new Map(); // tunnelId -> { token, control }
const pending = new Map(); // connId -> { token, core, queue, timer }

const log = (...a) => console.log(new Date().toISOString(), ...a);
const same = (a, b) => {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};
const reject = (socket, code, text) => {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
};
// 1005/1006/1015 are reserved and cannot be sent in a close frame.
const closeCode = (code) => (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1011);

function keepAlive(ws) {
  const t = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), PING_MS);
  ws.on("close", () => clearInterval(t));
}

function pipe(core, data, connId, queue) {
  for (const [msg, isBinary] of queue) data.send(msg, { binary: isBinary });
  core.removeAllListeners("message");
  core.on("message", (msg, isBinary) => data.readyState === data.OPEN && data.send(msg, { binary: isBinary }));
  data.on("message", (msg, isBinary) => core.readyState === core.OPEN && core.send(msg, { binary: isBinary }));
  core.on("close", (code, reason) => { log("core closed", connId, code); data.close(closeCode(code), reason); });
  data.on("close", (code, reason) => { log("data closed", connId, code); core.close(closeCode(code), reason); });
  core.on("error", () => {});
  data.on("error", () => {});
  keepAlive(data);
  log("piped", connId);
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });

// --- Secret hand-off and Launcher status (internal relationship only) ---------------------
// The plugin parks a task's secrets under a one-time fetch token. The task claims them once.
// These endpoints refuse anything that came through the public router.
const ADMIN_SECRET = process.env.RUNNER_RELAY_ADMIN_SECRET || "";
const PARK_TTL_MS = 10 * 60_000;
const parked = new Map();   // fetchToken -> { payload, tunnelId, expiresAt }
const launcherStatus = new Map(); // tunnelId -> { phase, exitCode, at, token }
const tunnelTokens = new Map(); // tunnelId -> relay token, from the parked payload
const runnerStates = new Map(); // tunnelId -> { state, at }, the runner's durable state mirror
setInterval(() => { const old = Date.now() - 6 * 3600_000; for (const [k, v] of runnerStates) if (v.at < old) runnerStates.delete(k); }, 600_000).unref();

const viaRouter = (req) => "x-original-route" in req.headers || "client-asn" in req.headers;
const readJson = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 16 * 1024 * 1024) req.destroy(); });
  req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch (e) { reject(e); } });
});
const json = (res, code, value) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
setInterval(() => { const now = Date.now(); for (const [k, v] of parked) if (v.expiresAt < now) parked.delete(k); }, 60_000).unref();

async function internalApi(req, res) {
  const url = new URL(req.url, "http://relay");
  let m;
  if (url.pathname === "/admin/park" && req.method === "POST") {
    if (!ADMIN_SECRET || !same(ADMIN_SECRET, req.headers["x-relay-admin"])) return json(res, 401, { error: "unauthorized" });
    const { fetchToken, tunnelId, payload } = await readJson(req);
    if (!fetchToken || !ID.test(tunnelId ?? "") || !payload?.relayToken) return json(res, 400, { error: "bad request" });
    parked.set(fetchToken, { payload, tunnelId, expiresAt: Date.now() + PARK_TTL_MS });
    tunnelTokens.set(tunnelId, payload.relayToken);
    launcherStatus.set(tunnelId, { phase: "submitted", at: new Date().toISOString() });
    log("parked", tunnelId);
    return json(res, 200, { ok: true });
  }
  if ((m = url.pathname.match(/^\/admin\/status\/([^/]+)$/)) && req.method === "GET") {
    if (!ADMIN_SECRET || !same(ADMIN_SECRET, req.headers["x-relay-admin"])) return json(res, 401, { error: "unauthorized" });
    return json(res, 200, launcherStatus.get(m[1]) ?? null);
  }
  if ((m = url.pathname.match(/^\/claim\/([a-f0-9]{48})$/)) && req.method === "POST") {
    const entry = parked.get(m[1]);
    if (!entry) return json(res, 404, { error: "unknown or already claimed" });
    parked.delete(m[1]);
    log("claimed", entry.tunnelId);
    return json(res, 200, entry.payload);
  }
  // Runner durable state mirror: pushed by the Launcher, read by the plugin for read_state.
  if ((m = url.pathname.match(/^\/state\/([^/]+)$/)) && req.method === "POST") {
    if (!same(tunnelTokens.get(m[1]), req.headers["x-relay-token"])) return json(res, 401, { error: "unauthorized" });
    const state = await readJson(req);
    runnerStates.set(m[1], { state, at: Date.now() });
    return json(res, 200, { ok: true });
  }
  if ((m = url.pathname.match(/^\/admin\/state\/([^/]+)$/)) && req.method === "GET") {
    if (!ADMIN_SECRET || !same(ADMIN_SECRET, req.headers["x-relay-admin"])) return json(res, 401, { error: "unauthorized" });
    return json(res, 200, runnerStates.get(m[1])?.state ?? null);
  }
  if ((m = url.pathname.match(/^\/status\/([^/]+)$/)) && req.method === "POST") {
    if (!same(tunnelTokens.get(m[1]), req.headers["x-relay-token"])) return json(res, 401, { error: "unauthorized" });
    const { phase, exitCode, detail } = await readJson(req);
    launcherStatus.set(m[1], { phase, ...(typeof exitCode === "number" ? { exitCode } : {}), ...(detail ? { detail: String(detail).slice(0, 2000) } : {}), at: new Date().toISOString() });
    log("launcher status", m[1], phase, exitCode ?? "", detail ? String(detail).slice(0, 300) : "");
    return json(res, 200, { ok: true });
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  if (/^\/(admin|claim|status|state)\//.test(req.url)) {
    if (viaRouter(req)) return json(res, 404, { error: "not found" });
    try { if ((await internalApi(req, res)) !== false) return; } catch (e) { return json(res, 400, { error: e.message }); }
    return json(res, 404, { error: "not found" });
  }
  if (req.headers.upgrade === undefined && /^\/(t|tunnel|data)\//.test(req.url)) {
    log("plain request on a websocket path (upgrade header missing)", req.method, req.url, req.headers["user-agent"]);
  }
  if (req.url === "/healthz") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, tunnels: tunnels.size, pending: pending.size }));
    return;
  }
  // Diagnostic (router investigation): answer after ?s= seconds, log every arrival and whether
  // the client went away first. /slow goes through a buffered location (like Paperclip's),
  // /nb/slow through the unbuffered "/" location. ?trickle=1 sends a byte every 5 s meanwhile.
  {
    const u = new URL(req.url, "http://relay");
    if (u.pathname === "/slow" || u.pathname === "/nb/slow") {
      const seconds = Math.min(Number(u.searchParams.get("s") || 30), 300);
      const tag = String(u.searchParams.get("tag") || "-").slice(0, 40);
      const started = Date.now();
      const proto = `${req.headers["x-forwarded-proto"] ?? "?"} http/${req.httpVersion}`;
      log(`SLOW arrive tag=${tag} ${req.method} ${u.pathname} s=${seconds} ${proto} ua=${String(req.headers["user-agent"] ?? "").slice(0, 60)}`);
      req.resume();
      let done = false;
      res.on("close", () => { if (!done) log(`SLOW client-gone tag=${tag} after ${Date.now() - started}ms`); });
      let trickle;
      if (u.searchParams.get("trickle") === "1") {
        res.writeHead(200, { "content-type": "text/plain" });
        trickle = setInterval(() => res.write("."), 5000);
      }
      setTimeout(() => {
        clearInterval(trickle);
        done = true;
        if (!res.headersSent) res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, tag, waitedMs: Date.now() - started }));
        log(`SLOW done tag=${tag} after ${Date.now() - started}ms`);
      }, seconds * 1000);
      return;
    }
  }
  res.statusCode = 404;
  res.end();
});

server.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url, "http://relay").pathname;
  const token = req.headers["x-relay-token"];
  let m;

  // Control channel from the task shim. First registration sets the tunnel's token.
  if ((m = path.match(/^\/tunnel\/([^/]+)$/)) && ID.test(m[1])) {
    const id = m[1];
    const existing = tunnels.get(id);
    if (!token || (existing && !same(existing.token, token))) return reject(socket, 401, "Unauthorized");
    return wss.handleUpgrade(req, socket, head, (ws) => {
      if (existing?.control) existing.control.close(4000, "replaced");
      tunnels.set(id, { token, control: ws });
      keepAlive(ws);
      log("tunnel up", id);
      ws.on("close", () => {
        if (tunnels.get(id)?.control === ws) tunnels.delete(id);
        log("tunnel down", id);
      });
      ws.on("error", () => {});
    });
  }

  // Data channel from the task shim, answering an "open" request.
  if ((m = path.match(/^\/data\/([0-9a-f-]{36})$/))) {
    const p = pending.get(m[1]);
    if (!p || !same(p.token, token)) return reject(socket, 401, "Unauthorized");
    pending.delete(m[1]);
    clearTimeout(p.timer);
    return wss.handleUpgrade(req, socket, head, (data) => pipe(p.core, data, m[1], p.queue));
  }

  // Core-facing endpoint: /t/<tunnelId>/<runner path>.
  if ((m = path.match(/^\/t\/([^/]+)(\/.*)$/)) && ID.test(m[1])) {
    const t = tunnels.get(m[1]);
    if (!t) return reject(socket, 404, "Not Found");
    if (!same(t.token, token)) return reject(socket, 401, "Unauthorized");
    const connId = crypto.randomUUID();
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k)) headers[k] = v;
    return wss.handleUpgrade(req, socket, head, (core) => {
      const queue = [];
      core.on("message", (msg, isBinary) => queue.push([msg, isBinary]));
      keepAlive(core);
      const timer = setTimeout(() => {
        pending.delete(connId);
        log("data channel timeout", connId);
        core.close(1011, "runner tunnel did not answer");
      }, DATA_WAIT_MS);
      pending.set(connId, { token: t.token, core, queue, timer });
      core.on("close", () => {
        const p = pending.get(connId);
        if (p) { clearTimeout(p.timer); pending.delete(connId); }
      });
      t.control.send(JSON.stringify({ type: "open", connId, path: m[2], headers }));
      log("core connected", m[1], connId, m[2]);
    });
  }

  reject(socket, 404, "Not Found");
});

server.listen(PORT, "0.0.0.0", () => log(`runner-relay listening on ${PORT}`));
