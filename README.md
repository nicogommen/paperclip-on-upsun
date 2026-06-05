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

Scaffold. Not yet deployed. See `../JOURNAL.md` for current state and `../PLAN.md` for the phased plan.

- Paperclip pinned to release **v2026.529.0**.
- Target runtimes: Node.js 26 (24 fallback), PostgreSQL 18.
