# task/ — the `upsun-agent` task entry point (Phase 2)

What runs inside the Upsun task container on each agent heartbeat. Modeled on the playground's `coding-agent` task.

Reads from env: `AGENT_PROMPT`, `PAPERCLIP_API_KEY`, `PAPERCLIP_BASE_URL` (plus the agent's model-provider key, e.g. `ANTHROPIC_API_KEY`, set as a sensitive var on the task). Runs the agent CLI (`claude` / `codex`) non-interactively to completion, calls back to Paperclip's API to post its work and telemetry, then exits.

v1 scope: **coordination/knowledge agents** — no git repo, no shared filesystem (PLAN principle 5). The agent CLI is installed in the task build hook (tasks reject `dependencies`/`stack`, SPEC Q5 gap), e.g. `npm i -g @anthropic-ai/claude-code`.

Empty until Phase 2.
