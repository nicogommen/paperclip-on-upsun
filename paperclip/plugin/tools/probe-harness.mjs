// Runs Paperclip Core's plugin Runner setup probe against this plugin, from inside the
// Paperclip app container, without the UI.
//   node /app/plugin/tools/probe-harness.mjs [--core] [--budget=SECONDS] [--model=ID]
// --core      : Core's probePluginRunnerEnvironment as is (fixed 45 s budget, which includes
//               the Upsun task cold start).
// default     : the same steps composed from the same Core internals, with --budget
//               (default 120 s), to validate the runtime path independently of that budget.
// Core code comes from the pinned upstream build, bundled at build time (dist/probe).
// The Claude credential is the app's ANTHROPIC_API_KEY (project variable), as claude-env.

import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../dist/hooks/server.mjs";
import * as core from "../dist/probe/server.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const model = args.model || "claude-sonnet-5-5";
const budgetMs = Number(args.budget || 120) * 1000;
const log = (...a) => console.log(new Date().toISOString(), "[harness]", ...a);
if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in this container");

const hooks = plugin.definition;
const lease = await hooks.onEnvironmentAcquireLease({ driverKey: "upsun-task", companyId: "harness", environmentId: "harness", config: {}, runId: randomUUID() });
const taskId = lease.providerLeaseId;
const runId = randomUUID(), sessionId = randomUUID(), leaseId = randomUUID();
log("lease", taskId, "run", runId);

let lastStatus = "";
const runnerTask = async (operation) => {
  const started = Date.now();
  try {
    const result = await hooks.onEnvironmentTask({
      driverKey: "upsun-task", companyId: "harness", environmentId: "harness", config: {},
      lease, taskId, runId, agentId: null, projectIds: [], operation,
    });
    const brief = result.kind === "status" ? `${result.phase} stopped=${result.executionStopped}` : result.kind;
    if (operation.kind !== "status" || brief !== lastStatus) log(`op ${operation.kind} -> ${brief} (${Date.now() - started}ms)`);
    if (operation.kind === "status") lastStatus = brief;
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
const managed = { identity: "harness-revision", accountIdentity: "harness-account" };
const started = Date.now();
let outcome;
try {
  if (args.core) {
    outcome = await core.probePluginRunnerEnvironment({
      companyId: "harness", adapterType: "paperclip_runner", config,
      executionTarget: { kind: "remote", transport: "sandbox", providerKey: "plugin", remoteCwd: ".", leaseId,
        runnerTaskProbe: { runId, sessionId }, runnerTask },
    }, managed);
  } else {
    // Same composition as server/src/services/native-runtime/plugin-runner-probe.ts.
    const profile = core.resolvePaperclipRunnerProviderProfile(config);
    const description = await runnerTask({ kind: "describe" });
    const credentials = await core.preparePluginRunnerCredentials({ provider: profile.acpxAgent, ...managed, environment: config.env });
    const owner = core.createPluginRunnerTaskOwner({ ...credentials, taskId: description.taskId,
      projectAuthCheckVersion: description.projectAuthCheckVersion, task: runnerTask, projectIds: [],
      harness: profile.acpxAgent, credentialIdentity: managed.identity });
    const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-probe-")));
    const result = await core.probeNativeRunnerEnvironment({ runtimeDirectory: root, provider: profile.provider,
      model: profile.model, timeoutMs: budgetMs, environment: {},
      transportOptions: { ...owner.driver, runnerArtifact: description.runner,
        acpxAgent: profile.acpxAgent, acpxPermissionMode: "deny-all", acpxPermissionModePinned: true,
        claudeEffort: core.resolveClaudeEffort("claude", undefined),
        acpxCandidateProfile: core.resolveAcpxQualification({ kind: "acpx", agent: profile.acpxAgent, model: profile.model }, process.env),
        prpIdentity: { runnerInstanceId: `probe-${randomUUID()}`, environmentLeaseId: leaseId, runId,
          normalizedSessionId: sessionId, turnId: `turn-${runId}`, itemId: `item-${runId}` } },
      onCleanupConfirmed: async () => { rmSync(root, { recursive: true, force: true }); },
    });
    outcome = { status: "pass", result };
  }
} catch (e) {
  outcome = { status: "fail", error: e.message, code: e.code, operationError: e.operationError?.message,
    cleanupErrors: e.cleanupErrors?.map((x) => x.message) };
}
log(`finished in ${Date.now() - started}ms`);
console.log(JSON.stringify(outcome, null, 2));
await runnerTask({ kind: "stop" }).catch(() => null);
await hooks.onEnvironmentReleaseLease({ driverKey: "upsun-task", companyId: "harness", environmentId: "harness", config: {}, providerLeaseId: taskId });
process.exit(outcome.status === "pass" ? 0 : 1);
