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
.upsun/config.yaml    Upsun config: paperclip app, runner-relay app, postgresql, runner task
paperclip/upstream/   Paperclip, pinned as a git submodule to a release tag, never edited
paperclip/plugin/     our Upsun task plugin (bundled at build, installed from /app/plugin)
runner-task/          the runner task: Launcher (secrets, provider pack, tunnel, runnerd) + tunnel shim
relay/                runner-relay: WebSocket tunnel, one-time secret hand-off, Launcher status, state mirror
```

## Status

Agents run end to end: a Paperclip heartbeat starts a `runner` task, the agent does its work through Paperclip, and the run shows in Paperclip with its usage. See `../JOURNAL.md` for the current state.

- Paperclip pinned to release **v2026.1117.0**.
- Runtimes: Node.js 26 for the apps and tasks, PostgreSQL 18.
- The app build needs at least 4 GB of build memory (tsc plus a Rust compile of the Paperclip runner).
- The app and the runner task run on the BALANCED container profile (about 0.5 GB used at idle by the app).

## Setup in Paperclip (once per environment)

Some steps have no UI yet, so they go through Paperclip's API as an instance admin (for example from the browser console while logged in).

1. Install the plugin: `POST /api/plugins/install` with `{"packageName": "/app/plugin", "isLocalPath": true}`. The UI dialog only installs npm packages.
2. Turn on Settings > Experimental > Environments.
3. Create the environment: `POST /api/companies/<companyId>/environments` with `{"name": "Upsun task container", "driver": "plugin", "config": {"pluginKey": "upsun.task-environment", "driverKey": "upsun-task", "driverConfig": {"taskName": "runner"}}}`. The UI form doesn't list plugin task drivers.
4. Add an Anthropic connection in Connectors (API key mode). Paperclip holds the key and hands it to each run.
5. Create the agent in the UI (Claude Code, environment "Upsun task container"), but don't use "Run test" or "Finish setup": on Upsun the UI's long test request gets re-sent and each re-send starts a task (see `../JOURNAL.md`). Finish with `POST /api/companies/<companyId>/agent-hires` using the draft's settings, then Paperclip verifies the agent on the server.

The relay needs one sensitive environment variable, `env:RUNNER_RELAY_ADMIN_SECRET` (random, runtime only, not inheritable).
