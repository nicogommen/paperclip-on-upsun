// net-probe task: answers "can a Paperclip Runner in an Upsun task be reached?".
//  1. Prints the task's hostname, IPs and relationships.
//  2. Listens on 0.0.0.0:43127 (the runner's default port) with an echo WebSocket server
//     standing in for paperclip-runnerd, and logs every inbound connection. Any connection
//     that does not come from the local shim proves direct inbound reachability.
//  3. Checks outbound paths: app and relay over relationships, relay over its public route.
//  4. Starts the tunnel shim so Core-side clients can reach the echo server via the relay.
// Inputs (task variables): RELAY_URL (wss://...), TUNNEL_ID, RELAY_TOKEN, PROBE_SECONDS.

import os from "node:os";
import http from "node:http";
import { WebSocketServer } from "ws";
import { startShim } from "./shim.mjs";

const SECONDS = Number(process.env.PROBE_SECONDS || 240);
const PORT = 43127;
const log = (...a) => console.log(new Date().toISOString(), ...a);

function relationships() {
  try {
    return JSON.parse(Buffer.from(process.env.PLATFORM_RELATIONSHIPS || "", "base64").toString() || "{}");
  } catch {
    return {};
  }
}

async function check(label, url) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = (await res.text()).slice(0, 120).replace(/\s+/g, " ");
    log(`CHECK ${label}: ${res.status} in ${Date.now() - started}ms ${body}`);
  } catch (e) {
    log(`CHECK ${label}: FAILED in ${Date.now() - started}ms ${e.cause?.code || e.message}`);
  }
}

const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
log(`PROBE_INFO hostname=${os.hostname()} ips=${ips.join(",")} node=${process.version}`);
const rels = relationships();
for (const [name, eps] of Object.entries(rels)) {
  for (const ep of eps) log(`PROBE_REL ${name} -> ${ep.scheme}://${ep.host}:${ep.port} (ip ${ep.ip}, hostname ${ep.hostname})`);
}

// Stand-in runner: HTTP + echo WebSocket on the runner port, logging every peer.
let inbound = 0;
const server = http.createServer((req, res) => {
  inbound++;
  log(`INBOUND_HTTP from=${req.socket.remoteAddress} ${req.method} ${req.url}`);
  res.end("net-probe ok\n");
});
const wss = new WebSocketServer({ server, perMessageDeflate: false });
wss.on("connection", (ws, req) => {
  inbound++;
  const names = Object.keys(req.headers).sort().join(",");
  log(`INBOUND_WS from=${req.socket.remoteAddress} path=${req.url} x-test=${req.headers["x-test"] ?? "-"} headers=${names}`);
  ws.send(JSON.stringify({ hello: "from-task", path: req.url, xTest: req.headers["x-test"] ?? null }));
  ws.on("message", (m, isBinary) => ws.send(isBinary ? m : `echo:${m}`, { binary: isBinary }));
});
server.listen(PORT, "0.0.0.0", () => log(`PROBE_LISTEN 0.0.0.0:${PORT}`));

// Outbound paths.
for (const [name, eps] of Object.entries(rels)) {
  const ep = eps[0];
  const path = name === "relay" ? "/healthz" : "/api/health";
  await check(`relationship ${name}`, `http://${ep.host}:${ep.port}${path}`);
}
if (process.env.RELAY_URL) await check("relay public route", process.env.RELAY_URL.replace(/^wss:/, "https:") + "/healthz");

let shim;
if (process.env.RELAY_URL && process.env.TUNNEL_ID && process.env.RELAY_TOKEN) {
  shim = startShim({
    relayUrl: process.env.RELAY_URL,
    tunnelId: process.env.TUNNEL_ID,
    token: process.env.RELAY_TOKEN,
    target: `ws://127.0.0.1:${PORT}`,
  });
}

log(`PROBE_READY for ${SECONDS}s`);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
shim?.stop();
log(`PROBE_DONE inbound_total=${inbound}`);
server.close();
process.exit(0);
