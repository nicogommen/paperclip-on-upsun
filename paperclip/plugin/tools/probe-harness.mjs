// Runs Paperclip Core's own plugin Runner setup probe (what "Test environment" runs) against
// this plugin, from inside the Paperclip app container, without the UI.
//   node /app/plugin/tools/probe-harness.mjs [model]
// Uses upstream's compiled probe (server/dist/.../plugin-runner-probe.js), bundled with
// upstream's own bundleRuntime so its TypeScript workspace imports load, and calls this
// plugin's onEnvironmentTask hook in-process. The Claude credential comes from the app's
// ANTHROPIC_API_KEY environment variable (the project variable), as a claude-env credential.

import { randomUUID } from "node:crypto";
import plugin from "../dist/hooks/server.mjs";

const UPSTREAM = "/app/upstream";
const model = process.argv[2] || "claude-sonnet-5-5";
const log = (...a) => console.log(new Date().toISOString(), "[harness]", ...a);

if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in this container");

const { bundleRuntime } = await import(`${UPSTREAM}/server/scripts/bundle-runtime.mjs`);
const outdir = `/tmp/probe-harness-${process.pid}`;
await bundleRuntime({ entry: `${UPSTREAM}/server/dist/services/native-runtime/plugin-runner-probe.js`, outdir });
const { probePluginRunnerEnvironment } = await import(`${outdir}/server.mjs`);
log("probe bundled");

const hooks = plugin.definition;
const lease = await hooks.onEnvironmentAcquireLease({ driverKey: "upsun-task", companyId: "harness", environmentId: "harness", config: {}, runId: randomUUID() });
const taskId = lease.providerLeaseId;
const runId = randomUUID();
log("lease", taskId);

const runnerTask = async (operation) => {
  const started = Date.now();
  try {
    const result = await hooks.onEnvironmentTask({
      driverKey: "upsun-task", companyId: "harness", environmentId: "harness", config: {},
      lease, taskId, runId, agentId: null, projectIds: [], operation,
    });
    const brief = result.kind === "status" ? `${result.phase} stopped=${result.executionStopped}` : result.kind;
    if (operation.kind !== "status" || result.phase !== "preparing") log(`op ${operation.kind} -> ${brief} (${Date.now() - started}ms)`);
    return result;
  } catch (e) {
    log(`op ${operation.kind} FAILED: ${e.message}`);
    throw e;
  }
};

const config = {
  provider: "acpx", acpxAgent: "claude", model,
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  managedAiConnection: { identity: "harness-revision", sessionIdentity: "harness-account" },
};
const started = Date.now();
const result = await probePluginRunnerEnvironment({
  companyId: "harness", adapterType: "paperclip_runner", config,
  executionTarget: { kind: "remote", transport: "sandbox", providerKey: "plugin", remoteCwd: ".", leaseId: randomUUID(),
    runnerTaskProbe: { runId, sessionId: randomUUID() }, runnerTask },
}, { identity: "harness-revision", accountIdentity: "harness-account" });
log(`probe finished in ${Date.now() - started}ms`);
console.log(JSON.stringify(result, null, 2));
await hooks.onEnvironmentReleaseLease({ driverKey: "upsun-task", companyId: "harness", environmentId: "harness", config: {}, providerLeaseId: taskId });
process.exit(result.status === "pass" ? 0 : 1);
