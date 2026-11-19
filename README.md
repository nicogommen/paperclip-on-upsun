# paperclip-on-upsun

Deploy [Paperclip](https://paperclip.ing/) on [Upsun](https://upsun.com/) and run the AI agents it triggers inside Upsun's **task container** (an ephemeral, API-triggered, run-to-completion container) instead of on the Paperclip host.

This is a showcase project for the Upsun task container. The plan, progress log and reference material live one directory up in the PM workspace (`../PLAN.md`, `../JOURNAL.md`, `../REFERENCE.md`). This repo is the deployable artifact.

## How it works

- **Paperclip** organizes the agents and decides when each one works. It runs unmodified.
- **Our plugin** (`paperclip/plugin`) is a standard Paperclip task-environment plugin. When an agent works, it starts a `runner` task on Upsun.
- **The `runner` task** runs Paperclip's own Runner (`paperclip-runnerd`) with Claude, for one turn, then exits. It is billed only while it runs.
- **`runner-relay`** connects Paperclip to the runner. Paperclip has to open a connection to the runner, and a task accepts no inbound connections, so both sides dial the relay.

**We never modify Paperclip's source.** Paperclip is pinned as a git submodule under `paperclip/upstream`, and our code hooks in only through Paperclip's documented extension points (plugins, env vars).

## Layout

```
.upsun/config.yaml    Upsun config: paperclip app, runner-relay app, postgresql, runner and upsun-agent tasks
paperclip/upstream/   Paperclip, pinned as a git submodule to a release tag, never edited
paperclip/plugin/     our Upsun task plugin (bundled at build, installed from /app/plugin)
runner-task/          the runner task: Launcher (secrets, provider pack, tunnel, runnerd) + tunnel shim
relay/                runner-relay: WebSocket tunnel, one-time secret hand-off, Launcher status
task/                 upsun-agent: the earlier adapter-route task, kept until that route is retired
adapter/, scripts/    placeholders from the adapter route
```

## Status

The plugin, the runner task and the relay are deployed. Paperclip reaches the runner in a task through the relay, and Claude Code starts there. A full agent run still needs the setup steps in the Paperclip UI below. See `../JOURNAL.md` for the current state.

- Paperclip pinned to release **v2026.1117.0**.
- Runtimes: Node.js 26 for the apps and tasks, PostgreSQL 18.
- The app build needs at least 4 GB of build memory (tsc plus a Rust compile of the Paperclip runner).
- The app and the runner task run on the BALANCED container profile (about 0.5 GB used at idle by the app).

## Setup in the Paperclip UI (once per environment)

1. Install the plugin from the local path `/app/plugin`.
2. Add an Anthropic AI connection. Paperclip holds the key and hands it to each run.
3. Create an environment with the driver "Upsun task container".
4. Create an agent on that environment (Paperclip Runner, Claude through ACPX), then wake it.

The relay needs one sensitive environment variable, `env:RUNNER_RELAY_ADMIN_SECRET` (random, runtime only, not inheritable).
