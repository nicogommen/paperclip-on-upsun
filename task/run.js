// upsun-agent task entry point (Phase 2).
// Runs ONE Paperclip agent heartbeat inside an ephemeral Upsun task container:
// reads the prompt + Paperclip context from env, runs the Claude Code CLI headless
// to completion, and prints a structured, parseable trace (incl. usage markers) the
// adapter can read back from the Upsun activity log.
//
// v1 scope: coordination/knowledge agent, no git workspace (PLAN principle 5).
// The Paperclip API callback (tools/MCP) lands in Phase 3 — here we only read+log
// the Paperclip env so the wiring is visible. Modeled on the playground coding-agent.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const HOME_DIR = "/tmp/agent-home"; // /tmp is the only writable mount; Claude writes ~/.claude here

function envProbe() {
  console.log("=".repeat(60));
  console.log("ENV PROBE (PLATFORM_* / UPSUN_* / *TASK*):");
  for (const k of Object.keys(process.env).sort()) {
    const u = k.toUpperCase();
    if (u.startsWith("PLATFORM_") || u.startsWith("UPSUN_") || u.includes("TASK")) {
      const v = process.env[k] ?? "";
      console.log(`  ${k}=${v.length < 200 ? v : v.slice(0, 200) + "..."}`);
    }
  }
  console.log("=".repeat(60));
}

function runClaude(prompt, model) {
  return new Promise((resolve) => {
    const args = [
      "-p",
      "--output-format", "json",
      "--model", model,
      "--permission-mode", "bypassPermissions", // ephemeral isolated sandbox: fully autonomous, no prompts
    ];
    const child = spawn("claude", args, {
      env: { ...process.env, HOME: HOME_DIR },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => process.stderr.write(d)); // surface CLI errors live
    child.on("error", (e) => resolve({ spawnError: e }));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.write(prompt); // stdin is robust for long/multi-line prompts
    child.stdin.end();
  });
}

// Machine-readable markers, one per line — a contract the adapter parses from the log.
function emitMarkers(obj) {
  const usage = obj.usage ?? {};
  console.log(`RESULT_STATUS=${obj.is_error ? "error" : "ok"}`);
  if (obj.session_id) console.log(`SESSION_ID=${obj.session_id}`);
  if (obj.num_turns != null) console.log(`NUM_TURNS=${obj.num_turns}`);
  if (usage.input_tokens != null) console.log(`USAGE_INPUT_TOKENS=${usage.input_tokens}`);
  if (usage.output_tokens != null) console.log(`USAGE_OUTPUT_TOKENS=${usage.output_tokens}`);
  if (obj.total_cost_usd != null) console.log(`USAGE_COST_USD=${obj.total_cost_usd}`);
}

async function main() {
  envProbe();

  const prompt = (process.env.AGENT_PROMPT ?? "").trim();
  if (!prompt) {
    console.log('NO_PROMPT_FOUND — pass {"variables":{"env":{"AGENT_PROMPT":"..."}}} in the trigger payload');
    return 2;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("MISSING_ANTHROPIC_API_KEY — set it as a sensitive var on the upsun-agent task");
    return 2;
  }

  const model = (process.env.AGENT_MODEL ?? "").trim() || DEFAULT_MODEL;
  console.log(`model: ${model}`);
  console.log(`paperclip base url: ${(process.env.PAPERCLIP_BASE_URL ?? "").trim() || "(unset)"}`);
  console.log(`paperclip api key: ${process.env.PAPERCLIP_API_KEY ? "present" : "absent"}`);
  console.log(`prompt: ${prompt.length < 500 ? prompt : prompt.slice(0, 500) + "..."}`);

  mkdirSync(HOME_DIR, { recursive: true });

  console.log("--- running claude ---");
  const r = await runClaude(prompt, model);
  if (r.spawnError) {
    console.log(`CLAUDE_SPAWN_FAILED: ${r.spawnError.message} — is the claude CLI on PATH? (build hook: npm i -g @anthropic-ai/claude-code)`);
    return 1;
  }

  let obj = null;
  try {
    obj = JSON.parse(r.out);
  } catch {
    /* fall through to raw dump */
  }
  if (obj) {
    if (obj.result) {
      console.log("--- agent result ---");
      console.log(obj.result);
    }
    emitMarkers(obj);
  } else {
    console.log("--- claude raw stdout (non-JSON) ---");
    console.log(r.out.slice(0, 4000));
  }

  console.log(`CLAUDE_EXIT_CODE=${r.code}`);
  return r.code === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
