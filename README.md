# paperclip-on-upsun

Deploy [Paperclip](https://paperclip.ing/) on [Upsun](https://upsun.com/) and run the AI agents it triggers inside Upsun's **task container** (an ephemeral, API-triggered, run-to-completion container) instead of as in-process child processes on the Paperclip host.

This is a showcase project for the Upsun task container. The full plan, progress log, and reference material live one directory up in the PM workspace (`../PLAN.md`, `../JOURNAL.md`, `../REFERENCE.md`). This repo is the deployable artifact.

## How it works

Paperclip runs agents in **heartbeats**: wake up, start the agent's adapter, give it a prompt, run to completion, store results, exit. That lifecycle maps 1:1 onto a task-container run. We ship a self-contained **external adapter** (`upsun_task`) that, on each heartbeat, triggers an Upsun task run instead of spawning a local CLI. Paperclip stays the orchestration/management layer; the task container is the ephemeral, scale-to-zero execution layer.

**We never modify Paperclip's source.** Paperclip is pinned as a git submodule under `upstream/` and all of our code lives outside it, hooking in only through Paperclip's documented extension points (external adapter plugins, env vars).

## Layout

```
.upsun/config.yaml   Upsun config: the paperclip app, postgresql service, upsun-agent task
upstream/            Paperclip, pinned as a git submodule to a release tag — NEVER edited
adapter/             our self-contained external adapter plugin (independent npm package)
task/                the upsun-agent task: entry point + agent CLI install
scripts/             deploy glue: build upstream, register the adapter (adapter-plugins.json)
```

## Status

Paperclip runs on Upsun, and the `upsun-agent` task runs an agent CLI to completion. The adapter is not built yet. See `../JOURNAL.md` for current state and `../PLAN.md` for the phased plan.

- Paperclip pinned to release **v2026.1117.0**.
- Runtimes: Node.js 24 for the app (upstream requires >= 24.11), Node.js 26 for the task, PostgreSQL 18.
- The app build needs at least 4 GB of build memory (tsc plus a Rust compile of the Paperclip runner).
