// Plugin worker process entry point (forked by Paperclip's plugin worker manager).
import { runWorker } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";

export default plugin;
runWorker(plugin, import.meta.url);
