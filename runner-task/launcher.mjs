// Launcher for one Paperclip Runner turn inside an Upsun task container.
//  1. Claims its launch payload (bootstrap ticket, credential, agent files) from the relay,
//     once, with the one-time token the plugin passed as a task variable.
//  2. Downloads the provider pack (runnerd + node + ACPX/Claude tooling) from the Paperclip
//     app over the internal relationship and checks its SHA-256.
//  3. Opens the outbound tunnel to the relay, then starts paperclip-runnerd listening on
//     127.0.0.1-reachable 0.0.0.0:43127, with the ticket in its environment (never argv).
//  4. Reports its phase to the relay (the plugin's `status` reads it) and exits with runnerd.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createZstdDecompress } from "node:zlib";
import { startShim } from "./shim.mjs";

const PORT = 43127;
const log = (...a) => console.log(new Date().toISOString(), "[launcher]", ...a);

function relationship(name) {
  const rels = JSON.parse(Buffer.from(process.env.PLATFORM_RELATIONSHIPS || "", "base64").toString() || "{}");
  const ep = rels[name]?.[0];
  if (!ep) throw new Error(`relationship ${name} missing`);
  return `http://${ep.host}:${ep.port}`;
}

const relayHttp = relationship("relay");
const appHttp = relationship("pcapp");
const tunnelId = process.env.RUNNER_TUNNEL_ID;
let relayToken;

async function report(phase, extra = {}) {
  if (!relayToken) return;
  try {
    await fetch(`${relayHttp}/status/${tunnelId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-token": relayToken },
      body: JSON.stringify({ phase, ...extra }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) { log("status report failed", e.message); }
}

async function claim() {
  const res = await fetch(`${relayHttp}/claim/${process.env.RUNNER_FETCH_TOKEN}`, { method: "POST" });
  if (!res.ok) throw new Error(`claim failed: ${res.status}`);
  return res.json();
}

async function fetchPack(expectedSha, target) {
  const started = Date.now();
  const res = await fetch(`${appHttp}/_upsun-runner/provider-pack.tar.zst`);
  if (!res.ok) throw new Error(`pack download failed: ${res.status}`);
  const archive = "/tmp/provider-pack.tar.zst";
  const hash = createHash("sha256");
  const body = Readable.fromWeb(res.body);
  body.on("data", (c) => hash.update(c));
  await pipeline(body, createWriteStream(archive));
  const sha = hash.digest("hex");
  if (sha !== expectedSha) throw new Error(`pack sha256 mismatch: ${sha}`);
  log(`pack downloaded in ${Date.now() - started}ms`);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const tar = spawn("tar", ["-xf", "-", "-C", target], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((resolve, reject) => tar.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`)))));
  await pipeline(createReadStream(archive), createZstdDecompress(), tar.stdin);
  await done;
  await rm(archive, { force: true });
  log(`pack extracted in ${Date.now() - started}ms total`);
}

async function fetchRunner(expectedDigest, target) {
  const res = await fetch(`${appHttp}/_upsun-runner/paperclip-runnerd`);
  if (!res.ok) throw new Error(`runnerd download failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== expectedDigest) throw new Error(`runnerd digest mismatch: ${digest}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { mode: 0o755 });
  log(`runnerd ${bytes.length} bytes, digest ok`);
}

async function writeBundles(bundles) {
  for (const bundle of bundles) {
    for (const file of bundle.files) {
      const path = join(bundle.target, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(file.base64, "base64"));
      await chmod(path, file.mode || 0o644);
    }
  }
}

async function waitForPort(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = createConnection({ host: "127.0.0.1", port: PORT });
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => { s.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("runnerd did not start listening");
}

async function main() {
  const payload = await claim();
  relayToken = payload.relayToken;
  await report("starting");
  const host = payload.host;
  await fetchPack(payload.pack.sha256, host.pack);
  const manifest = JSON.parse(await readFile(join(host.pack, "provider-pack.json"), "utf8"));
  if (manifest.digest !== payload.pack.digest) throw new Error("provider pack identity changed");
  const runnerBinaryPath = "/tmp/runner-bin/paperclip-runnerd";
  await fetchRunner(payload.launch.runnerDigest, runnerBinaryPath);
  for (const dir of [host.root, host.cwd, host.context, "/tmp/agent-home", "/tmp/runner-state"]) await mkdir(dir, { recursive: true });
  await writeBundles(payload.bundles);

  const shim = startShim({ relayUrl: relayHttp.replace(/^http/, "ws"), tunnelId, token: relayToken, target: `ws://127.0.0.1:${PORT}` });

  const { spawnRunner } = await import(join(host.pack, "dist/control-plane/durable-prp-control-plane.js"));
  const artifacts = manifest.payload.artifacts;
  const launch = payload.launch;
  const acpx = payload.providerKind === "acpx";
  const handle = spawnRunner({
    connection: { mode: "listen", listenAddress: "0.0.0.0", listenPort: PORT, listenPath: `/api/runner/v1/connect/${payload.identity.runId}` },
    stateDirectory: "/tmp/runner-state",
    identity: payload.identity,
    ticket: payload.ticket,
    maxOutboxBytes: launch.maxOutboxBytes,
    p0ReserveBytes: launch.p0ReserveBytes,
    ...(launch.maxRuntimeMs !== undefined ? { maxRuntimeMs: launch.maxRuntimeMs } : {}),
    ...(launch.maxLifetimeMs !== undefined ? { maxLifetimeMs: launch.maxLifetimeMs } : {}),
    ...(launch.reconnectGraceMs !== undefined ? { reconnectGraceMs: launch.reconnectGraceMs } : {}),
    lifecyclePolicy: launch.lifecyclePolicy,
    runnerBinaryPath,
    runnerVersion: launch.runnerVersion,
    runnerDigest: launch.runnerDigest,
    ...(acpx ? { acpxLaunchProfile: {
      authorityDigest: manifest.digest,
      command: join(host.pack, artifacts.nodeCommand.path),
      commandSha256: artifacts.nodeCommand.sha256,
      sidecarScript: join(host.pack, artifacts.acpxSidecar.path),
      sidecarScriptSha256: artifacts.acpxSidecar.sha256,
    } } : {}),
    environment: {
      PATH: `${join(host.pack, "node_modules/.bin")}:${process.env.PATH}`,
      HOME: "/tmp/agent-home",
      ...payload.credentialEnv,
    },
    diagnosticsDirectory: "/tmp/runner-diagnostics",
  });
  handle.child.stderr?.on?.("data", (d) => process.stderr.write(d));
  handle.child.stdout?.on?.("data", (d) => process.stdout.write(d));

  try {
    await waitForPort(20_000);
    log("runnerd listening");
    await report("running");
  } catch (e) {
    await report("exited", { exitCode: 1, detail: e.message });
    throw e;
  }
  const result = await handle.completion;
  log("runnerd exited", JSON.stringify({ code: result.code, signal: result.signal }));
  if (result.stderr) log("runnerd stderr tail:", String(result.stderr).slice(-2000));
  await report("exited", { exitCode: result.code ?? 1, ...(result.code ? { detail: String(result.stderr ?? "").slice(-1500) } : {}) });
  shim.stop();
  process.exit(result.code ?? 1);
}

main().catch(async (e) => {
  log("FAILED", e.stack || e.message);
  await report("exited", { exitCode: 1, detail: e.message });
  process.exit(1);
});
