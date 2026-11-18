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

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, tunnels: tunnels.size, pending: pending.size }));
    return;
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
