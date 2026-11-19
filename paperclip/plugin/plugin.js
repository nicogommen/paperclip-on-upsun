// Paperclip plugin (hooks): a task-capable environment driver that runs each Paperclip Runner
// turn in an Upsun task container. worker.js is the process entry point.
//
// Flow for one turn (Core drives it through onEnvironmentTask):
//   describe  -> report the Runner binary the task will run (same bytes as the hosted pack)
//   prepare   -> build the provider descriptor with task-side paths (no process started)
//   submit    -> park the bootstrap ticket, credential and agent files in the relay under a
//                one-time token, then start the Upsun task through the local auth proxy
//   status    -> phase from the task's Launcher (via the relay) + Upsun activity state
//   connection-> wss URL of the relay tunnel for this task, plus its secret header
//   stop/complete/credentials as the contract requires
//
// Settings come from upsun-runner.json, written by the app's deploy hook on the mount
// (plugin workers get a minimal environment with no PLATFORM_* variables).

import { definePlugin } from "@paperclipai/plugin-sdk";
import {
  bindRunnerLaunchResources,
  createRunnerProviderLaunch,
  readRunnerdArtifactBinding,
  runnerLaunchRequirementsDigest,
} from "@paperclipai/paperclip-runner";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SETTINGS_PATH = process.env.UPSUN_RUNNER_SETTINGS ?? "/app/paperclip-home/upsun-runner.json";
const PACK_DIR = "/app/runner-pack";
const API = "https://api.upsun.com";

// Execution-host (task) layout. The Launcher creates these.
const HOST = {
  pack: "/tmp/pack",
  root: "/tmp/agent",
  cwd: "/tmp/agent/work",
  context: "/tmp/agent/context",
};

let settingsCache;
function settings() {
  if (!settingsCache) settingsCache = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  return settingsCache;
}

let packCache;
function pack() {
  if (!packCache) {
    const manifest = JSON.parse(readFileSync(join(PACK_DIR, "provider-pack.json"), "utf8"));
    const archive = JSON.parse(readFileSync(join(PACK_DIR, "provider-pack.archive.json"), "utf8"));
    const runner = readRunnerdArtifactBinding(join(PACK_DIR, "paperclip-runnerd"));
    packCache = { manifest, archive, runner };
  }
  return packCache;
}

// --- Upsun API through the app's auth proxy (no user token) -----------------------------
let token;
async function bearer() {
  if (token && Date.now() < token.expiresAt - 10_000) return token.value;
  const res = await fetch("http://localhost:8200/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-token-ttl": "900" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`auth proxy ${res.status}`);
  const body = await res.json();
  token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 900) * 1000 };
  return token.value;
}
async function upsun(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${await bearer()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Upsun API ${method} ${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// --- Relay (internal relationship, admin secret) ----------------------------------------
async function relay(method, path, body) {
  const s = settings();
  const res = await fetch(`${s.relayInternalUrl}${path}`, {
    method,
    headers: { "x-relay-admin": s.relayAdminSecret, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`relay ${method} ${path} -> ${res.status}`);
  return res.json();
}

// --- Per-task state (in memory: one turn per task, the worker outlives it) ---------------
const tasks = new Map();
const taskState = (taskId) => {
  let t = tasks.get(taskId);
  if (!t) { t = { taskId }; tasks.set(taskId, t); }
  return t;
};
const tunnelIdFor = (taskId) => taskId.replace(/[^A-Za-z0-9_-]/g, "").slice(-64);

// Files of one controller-side bundle directory, for the Launcher to recreate.
function readBundle(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) files.push({ path: relative(dir, p), mode: st.mode & 0o777, base64: readFileSync(p).toString("base64") });
    }
  };
  walk(dir);
  return files;
}

// Map controller bundle locations to task locations and collect their files.
function mapContext(context) {
  if (!context) return { mapped: null, bundles: [] };
  const bundles = [];
  const instructionsRoot = `${HOST.context}/instructions`;
  bundles.push({ target: instructionsRoot, files: readBundle(context.instructions.bundle.rootPath) });
  const skills = context.skills.map((skill) => {
    const target = `${HOST.context}/skills/${skill.runtimeName}`;
    bundles.push({ target, files: readBundle(skill.bundle.rootPath) });
    return { ...skill, bundle: { ...skill.bundle, rootPath: target } };
  });
  const mapped = {
    ...context,
    instructions: { ...context.instructions, bundle: { ...context.instructions.bundle, rootPath: instructionsRoot } },
    skills,
  };
  return { mapped, bundles };
}

function prepare(params, op) {
  const t = taskState(params.taskId);
  if (op.recovery) { t.prepared = { ...t.prepared, launch: op.recovery }; return op.recovery; }
  const requirements = op.requirements;
  const { mapped, bundles } = mapContext(requirements.runtimeContext);
  const p = pack();
  const artifacts = p.manifest.payload.artifacts;
  const bound = mapped ? bindRunnerLaunchResources(requirements, mapped) : requirements;
  const provider = createRunnerProviderLaunch(bound, {
    options: { codexArgs: [], externallySandboxed: true },
    root: HOST.root,
    cwd: HOST.cwd,
    codexHome: `${HOST.root}/codex`,
    codexCommand: `${HOST.pack}/node_modules/.bin/codex`,
    providerNodeCommand: `${HOST.pack}/${artifacts.nodeCommand.path}`,
    opencodeProxyPath: `${HOST.pack}/${artifacts.opencodeProxy.path}`,
    acpxSidecarPath: `${HOST.pack}/${artifacts.acpxSidecar.path}`,
  });
  const launch = {
    configurationId: `upsun-${requirements.identity.runId}-${randomUUID()}`,
    requirementsDigest: runnerLaunchRequirementsDigest(requirements),
    provider,
  };
  t.prepared = { launch, bundles, providerKind: requirements.provider, requirements };
  return launch;
}

async function submit(params, op) {
  const t = taskState(params.taskId);
  if (t.activityId) return; // at most once per task: a retry reconciles the same task
  const s = settings();
  const p = pack();
  t.tunnelId = tunnelIdFor(params.taskId);
  t.relayToken = randomBytes(24).toString("hex");
  t.credential = op.credential ?? null;
  t.runId = op.runner.runId;
  const fetchToken = randomBytes(24).toString("hex");
  const credentialEnv = op.credential?.type === "claude-env" ? op.credential.environment : {};
  await relay("POST", "/admin/park", {
    fetchToken,
    tunnelId: t.tunnelId,
    payload: {
      ticket: op.bootstrapTicket,
      credentialEnv,
      relayToken: t.relayToken,
      tunnelId: t.tunnelId,
      harness: op.runner.harness,
      providerKind: t.prepared?.providerKind ?? null,
      identity: {
        runnerInstanceId: op.runner.runnerId, environmentLeaseId: op.runner.leaseId, runId: op.runner.runId,
        normalizedSessionId: op.runner.sessionId, turnId: op.runner.turnId, itemId: op.runner.itemId,
      },
      launch: op.launch,
      bundles: t.prepared?.bundles ?? [],
      host: HOST,
      pack: { sha256: p.archive.sha256, digest: p.manifest.digest },
    },
  });
  const result = await upsun("POST", `/projects/${s.projectId}/environments/${encodeURIComponent(s.environment)}/tasks/${s.taskName}/run`, {
    variables: { env: { RUNNER_FETCH_TOKEN: fetchToken, RUNNER_TUNNEL_ID: t.tunnelId } },
  });
  t.activityId = result?._embedded?.activities?.[0]?.id ?? result?.id;
  if (!t.activityId) throw new Error("Upsun task run returned no activity");
}

const TERMINAL = new Set(["complete", "cancelled"]);
async function status(params) {
  const t = taskState(params.taskId);
  if (!t.activityId) return { kind: "status", taskId: params.taskId, phase: "preparing", executionStopped: !t.submitted, preparationStopped: true };
  const s = settings();
  const [activity, launcher] = await Promise.all([
    upsun("GET", `/projects/${s.projectId}/environments/${encodeURIComponent(s.environment)}/activities/${t.activityId}`),
    relay("GET", `/admin/status/${t.tunnelId}`).catch(() => null),
  ]);
  const stopped = TERMINAL.has(activity.state);
  let phase = "preparing";
  if (launcher?.phase === "running") phase = "running";
  if (launcher?.phase === "exited") phase = launcher.exitCode === 0 ? "completed" : "failed";
  if (stopped && phase !== "completed" && phase !== "failed") phase = activity.state === "cancelled" ? "cancelled" : "interrupted";
  return {
    kind: "status", taskId: params.taskId, phase,
    ...(typeof launcher?.exitCode === "number" ? { exitCode: launcher.exitCode } : {}),
    executionStopped: stopped,
    sessionStateAvailable: false,
  };
}

async function stop(params) {
  const t = taskState(params.taskId);
  t.stopRequested = true;
  if (!t.activityId) return;
  const s = settings();
  await upsun("POST", `/projects/${s.projectId}/environments/${encodeURIComponent(s.environment)}/activities/${t.activityId}/cancel`)
    .catch(() => null); // already finished
}

const plugin = definePlugin({
  async setup(ctx) { ctx.logger.info("Upsun task environment plugin ready"); },
  async onHealth() { return { status: "ok", message: "Upsun task environment plugin healthy" }; },
  async onEnvironmentValidateConfig(params) {
    return { ok: true, normalizedConfig: { taskName: params.config?.taskName ?? "runner" } };
  },
  async onEnvironmentProbe() {
    try {
      const s = settings();
      pack();
      return { ok: true, summary: `Upsun task "${s.taskName}" on environment ${s.environment}.`, metadata: { environment: s.environment } };
    } catch (e) {
      return { ok: false, summary: `Upsun runner settings or pack missing: ${e.message}` };
    }
  },
  async onEnvironmentAcquireLease() {
    return { providerLeaseId: `upsun-task-${randomUUID()}`, metadata: {} };
  },
  async onEnvironmentResumeLease(params) {
    return { providerLeaseId: params.providerLeaseId, metadata: {} };
  },
  async onEnvironmentReleaseLease(params) {
    if (params.providerLeaseId) tasks.delete(params.providerLeaseId);
  },
  async onEnvironmentDestroyLease(params) {
    if (params.providerLeaseId) { await stop({ taskId: params.providerLeaseId }).catch(() => null); tasks.delete(params.providerLeaseId); }
  },
  async onEnvironmentInspectLease(params) {
    return { providerLeaseId: params.providerLeaseId, state: tasks.has(params.providerLeaseId) ? "active" : "destroyed" };
  },
  async onEnvironmentTask(params) {
    const op = params.operation;
    const taskId = params.taskId;
    switch (op.kind) {
      case "describe": {
        const { runner } = pack();
        return { kind: "description", taskId, runner: { version: runner.version, digest: runner.digest },
          launchPreparationVersion: 1, projectAuthCheckVersion: 1 };
      }
      case "prepare":
        return { kind: "prepared", taskId, launch: prepare(params, op), projectAuthCheckAtSubmit: true };
      case "check_project_auth":
        // The task has no project checkout or config that could redirect the credential.
        return { kind: "project_auth", taskId, configurationId: op.configurationId, provider: op.provider, allowed: true };
      case "submit":
        taskState(taskId).submitted = true;
        await submit(params, op);
        return { kind: "accepted", taskId };
      case "status":
        return status(params);
      case "connection": {
        const t = taskState(taskId);
        if (!t.tunnelId) throw new Error("connection requested before submit");
        return { kind: "connection", taskId, endpoint: {
          kind: "authenticated_websocket",
          websocketUrl: `${settings().relayPublicWss}/t/${t.tunnelId}/api/runner/v1/connect/${t.runId}`,
          generation: t.tunnelId,
          secretHeaders: [{ name: "x-relay-token", value: t.relayToken }],
        } };
      }
      case "credentials":
        return { kind: "credentials", taskId, credential: taskState(taskId).credential ?? null };
      case "stop":
        await stop(params);
        return { kind: "accepted", taskId };
      case "complete":
        tasks.delete(taskId);
        return { kind: "accepted", taskId };
      default:
        throw new Error(`Unsupported task operation: ${op.kind}`);
    }
  },
});

export default plugin;
