# adapter/ — the `upsun_task` external adapter (Phase 3)

Self-contained external Paperclip adapter plugin (an independent npm package, e.g. `@upsun/paperclip-task-adapter`). Built and registered with Paperclip at runtime via `adapter-plugins.json` — **no edits to Paperclip source**.

On each heartbeat, its `execute()`:
1. `buildPaperclipEnv(agent)` to capture `PAPERCLIP_API_KEY`, `PAPERCLIP_AGENT_ID`, base URL.
2. `renderTemplate(...)` to build the prompt.
3. Mint a scoped token from the Upsun auth proxy (`localhost:8200`, `task:upsun-agent:operate`).
4. `POST tasks/upsun-agent/run` with the prompt + Paperclip credentials as task env.
5. Await terminal status, return an `AdapterExecutionResult`.

Must set capability `supportsLocalAgentJwt: true` (otherwise Paperclip does not inject `PAPERCLIP_API_KEY`). Depends on `@paperclipai/adapter-utils` (contract-version coupled). See `../PLAN.md` §5 and `../REFERENCE.md` §4.

Empty until Phase 3.
