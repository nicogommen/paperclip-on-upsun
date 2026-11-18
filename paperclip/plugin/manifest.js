// Paperclip plugin manifest: one task-capable environment driver backed by Upsun task containers.
const manifest = {
  id: "upsun.task-environment",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Upsun task containers",
  description:
    "Runs each agent turn in an ephemeral Upsun task container. The Paperclip Runner inside the task " +
    "is reached through the runner relay, because tasks accept no inbound connections.",
  author: "Upsun",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "./worker.js" },
  environmentDrivers: [
    {
      driverKey: "upsun-task",
      kind: "environment_driver",
      displayName: "Upsun task container",
      description: "One ephemeral Upsun task per agent turn. Configured by the deploy hook, no settings needed here.",
      supportsTasks: true,
      configSchema: {
        type: "object",
        properties: {
          taskName: { type: "string", description: "Upsun task that runs the Runner.", default: "runner" },
        },
      },
    },
  ],
};

export default manifest;
