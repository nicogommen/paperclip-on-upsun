// Runtime entry shim for the Paperclip server on Upsun.
//
// Why this exists: Paperclip's workspace packages export TS *source* (./src/*.ts)
// using .js import specifiers, so the server must run under the tsx loader (see
// .upsun/config.yaml). But loading the server as Node's *static* main entry makes
// Node resolve the import graph synchronously, which blocks on tsx's async
// module.register() loader worker and DEADLOCKS the boot (frozen process, no port
// bound, a defunct esbuild child). A *dynamic* import() of the same graph goes
// through tsx's async hooks and resolves correctly (verified live on the container).
//
// So we keep this shim as a plain-JS static entry (empty static graph) and pull in
// the real server via dynamic import — dodging the sync-resolution deadlock.
import { fileURLToPath } from "node:url";

const serverEntry = fileURLToPath(
  new URL("../upstream/server/dist/index.js", import.meta.url),
);

import(serverEntry).catch((err) => {
  console.error("[start.mjs] failed to load Paperclip server:", err);
  process.exit(1);
});
