// Task-side half of the runner relay (see ../relay/server.mjs).
// Dials OUT to the relay, and for each Core connection the relay announces, opens a data
// channel back to the relay plus a local WebSocket to the runner, then pipes the two.
// Outbound-only, so it works from an Upsun task, which accepts no inbound connections.

import WebSocket from "ws";

const log = (...a) => console.log(new Date().toISOString(), "[shim]", ...a);
const closeCode = (code) => (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1011);

export function startShim({ relayUrl, tunnelId, token, target }) {
  let stopped = false;
  let control;
  let attempt = 0;

  function bridge({ connId, path, headers }) {
    const local = new WebSocket(new URL(path, target), { headers, perMessageDeflate: false });
    const data = new WebSocket(`${relayUrl}/data/${connId}`, { headers: { "x-relay-token": token }, perMessageDeflate: false });
    const qLocal = [], qData = [];
    local.on("message", (m, b) => (data.readyState === data.OPEN ? data.send(m, { binary: b }) : qData.push([m, b])));
    data.on("message", (m, b) => (local.readyState === local.OPEN ? local.send(m, { binary: b }) : qLocal.push([m, b])));
    local.on("open", () => { for (const [m, b] of qLocal.splice(0)) local.send(m, { binary: b }); log("local open", connId, path); });
    data.on("open", () => { for (const [m, b] of qData.splice(0)) data.send(m, { binary: b }); log("data open", connId); });
    local.on("close", (c, r) => { log("local closed", connId, c); data.close(closeCode(c), r); });
    data.on("close", (c, r) => { log("data closed", connId, c); local.close(closeCode(c), r); });
    local.on("unexpected-response", (_req, res) => { log("local refused", connId, res.statusCode); data.close(1011, `runner ${res.statusCode}`); });
    local.on("error", (e) => log("local error", connId, e.message));
    data.on("error", (e) => log("data error", connId, e.message));
  }

  function connect() {
    if (stopped) return;
    control = new WebSocket(`${relayUrl}/tunnel/${tunnelId}`, { headers: { "x-relay-token": token }, perMessageDeflate: false });
    control.on("open", () => { attempt = 0; log("tunnel registered", tunnelId); });
    control.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === "open") bridge(msg);
    });
    control.on("close", (code) => {
      if (stopped) return;
      const delay = Math.min(10_000, 250 * 2 ** attempt++);
      log("tunnel closed", code, `retry in ${delay}ms`);
      setTimeout(connect, delay);
    });
    control.on("error", (e) => log("tunnel error", e.message));
  }

  connect();
  return { stop() { stopped = true; control?.close(1000, "task done"); } };
}
