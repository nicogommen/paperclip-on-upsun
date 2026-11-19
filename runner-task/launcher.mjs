// Launcher for one Paperclip Runner turn inside an Upsun task container.
//  1. Claims its launch payload (bootstrap ticket, credential, agent files) from the relay,
//     once, with the one-time token the plugin passed as a task variable.
//  2. Downloads the provider pack (runnerd + node + ACPX/Claude tooling) from the Paperclip
//     app over the internal relationship and checks its SHA-256.
//  3. Opens the outbound tunnel to the relay, then starts paperclip-runnerd listening on
//     127.0.0.1-reachable 0.0.0.0:43127, with the ticket in its environment (never argv).
//  4. Reports its phase to the relay (the plugin's `status` reads it) and exits with runnerd.

import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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

// Download, hash, decompress and extract in one stream (no temp file). The hash is checked at
// the end; a mismatch aborts the run before anything in the pack is executed.
async function fetchPack(expectedSha, target) {
  const started = Date.now();
  const res = await fetch(`${appHttp}/_upsun-runner/provider-pack.tar.zst`);
  if (!res.ok) throw new Error(`pack download failed: ${res.status}`);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const hash = createHash("sha256");
  const body = Readable.fromWeb(res.body);
  body.on("data", (c) => hash.update(c));
  const tar = spawn("tar", ["-xf", "-", "-C", target], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((resolve, reject) => tar.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`)))));
  await pipeline(body, createZstdDecompress(), tar.stdin);
  await done;
  const sha = hash.digest("hex");
  if (sha !== expectedSha) throw new Error(`pack sha256 mismatch: ${sha}`);
  log(`pack streamed and extracted in ${Date.now() - started}ms`);
}

// The Claude SDK native binary is installed in this task's image (package.json pins the same
// version as the pack) and copied back where the pack's dependency graph expects it. A copy,
// not a symlink: the ACPX sidecar refuses packages that resolve outside the pack root.
async function linkClaudeSdk(packRoot) {
  const started = Date.now();
  const version = "0.3.286";
  const source = join(dirname(fileURLToPath(import.meta.url)), "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64");
  const target = join(packRoot, `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64@${version}/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64`);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, preserveTimestamps: true });
  log(`claude sdk copied in ${Date.now() - started}ms`);
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

// Container limits and OOM kills, plus runnerd's own diagnostics (credentials redacted).
async function dumpDiagnostics() {
  for (const f of ["/proc/self/cgroup", "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory.events", "/sys/fs/cgroup/cpu.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes", "/sys/fs/cgroup/memory/memory.failcnt", "/sys/fs/cgroup/memory/memory.oom_control"]) {
    try { log(`${f}: ${(await readFile(f, "utf8")).trim().replace(/\n/g, " | ")}`); } catch {}
  }
  try { log(`meminfo: ${(await readFile("/proc/meminfo", "utf8")).split("\n").slice(0, 3).join(" | ")}`); } catch {}
  const walk = async (dir) => {
    let names = [];
    try { names = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      try {
        const text = (await readFile(p, "utf8")).replace(/(sk-ant-[A-Za-z0-9_-]+|"?(api[_-]?key|token|ticket)"?\s*[:=]\s*"?)[^\s",}]+/gi, "$1[redacted]");
        log(`diag ${p} (${text.length} bytes) tail:\n${text.slice(-3000)}`);
      } catch {}
    }
  };
  await walk("/tmp/runner-diagnostics");
  await walk("/tmp/runner-state");
  await walk("/tmp/agent/acpx");
}

// The runner's durable state (runner-state.json), mirrored to the relay so the plugin can
// answer Core's read_state while the task runs and after it is gone. Pushed when it changes.
const STATE_FILE = "/tmp/runner-state/runner-state.json";
let lastState = "";
async function pushState() {
  let text;
  try { text = await readFile(STATE_FILE, "utf8"); } catch { return; }
  if (!text || text === lastState) return;
  try { JSON.parse(text); } catch { return; } // mid-write: try again on the next tick
  lastState = text;
  try {
    await fetch(`${relayHttp}/state/${tunnelId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-token": relayToken },
      body: text,
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) { log("state push failed", e.message); }
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
  await linkClaudeSdk(host.pack);
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
  const baseEnv = { PATH: `${join(host.pack, "node_modules/.bin")}:${process.env.PATH}`, HOME: "/tmp/agent-home", ...payload.credentialEnv };
  // With a plugin-prepared launch, Core sends the runner no provider environment: the process
  // owner supplies it. Build it with the runner's own function, as Core does for local launches
  // (ACPX package root and manifest, sanitized credentials, credential binding, identity).
  let providerEnv = {};
  if (acpx) {
    const { createCapabilityRunnerdProviderEnvironment } = await import(join(host.pack, "dist/live/runnerd-codex-transport.js"));
    const acpxSidecarPath = join(host.pack, artifacts.acpxSidecar.path);
    providerEnv = createCapabilityRunnerdProviderEnvironment({
      provider: "acpx",
      options: { acpxAgent: payload.harness, environment: baseEnv, stateDirectory: "/tmp/runner-state", acpxSidecarPath },
      identity: payload.identity,
      codexHome: join(host.root, "codex"),
      runtimeContextPath: "/tmp/runner-state/runtime-context.json",
      hasRuntimeContext: false,
      acpxSidecarPath,
    });
    log("provider env keys:", Object.keys(providerEnv).filter((k) => !/KEY|TOKEN|SECRET|BINDING/.test(k)).sort().join(","));
  }
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
    environment: { ...baseEnv, ...providerEnv },
    diagnosticsDirectory: "/tmp/runner-diagnostics",
  });
  handle.child.stderr?.on?.("data", (d) => process.stderr.write(d));
  handle.child.stdout?.on?.("data", (d) => process.stdout.write(d));

  try {
    await waitForPort(20_000);
    log("runnerd listening");
    await report("running");
  } catch (e) {
    // Stop runnerd before reporting: "exited" tells the plugin that nothing is running anymore.
    try { handle.child.kill("SIGKILL"); } catch {}
    await handle.completion.catch(() => null);
    await report("exited", { exitCode: 1, detail: e.message });
    throw e;
  }
  const stateTimer = setInterval(() => { pushState(); }, 500);
  const result = await handle.completion;
  clearInterval(stateTimer);
  await pushState(); // final state (suspended) before reporting exit
  log("runnerd exited", JSON.stringify({ code: result.code, signal: result.signal }));
  await dumpDiagnostics();
  if (result.stderr) log("runnerd stderr tail:", String(result.stderr).slice(-2000));
  shim.stop();
  await report("exited", { exitCode: result.code ?? 1, ...(result.code ? { detail: String(result.stderr ?? "").slice(-1500) } : {}) });
  process.exit(result.code ?? 1);
}

main().catch(async (e) => {
  log("FAILED", e.stack || e.message);
  await report("exited", { exitCode: 1, detail: e.message });
  process.exit(1);
});
