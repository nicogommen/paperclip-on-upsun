# scripts/ — deploy glue

Build- and deploy-hook helpers that wire our code to Paperclip without editing it:
- Build `upstream/` (the Paperclip submodule) on Upsun: corepack-activate the pinned pnpm, then build ui + server.
- If Upsun does not fetch submodules at build, fall back to `git clone --branch <tag> --depth 1` of the pinned tag into `upstream/` (PLAN open question #3).
- Register the adapter: write/refresh `adapter-plugins.json` under `PAPERCLIP_HOME` pointing at our built `adapter/` (or symlink), then restart so Paperclip picks it up.

Empty until Phase 1/3.
