import type { AgentPlugin } from "../types";

export const loopPlugin: AgentPlugin = {
  manifest: {
    id: "loop",
    version: "1.0.0",
    title: "Loop",
    runner: "cli",
    inputs: [],
    outputs: [],
    configSchema: {
      type: "object",
      properties: {
        delaySeconds: { type: "number" },
        carryContext: { type: "boolean" },
      },
    },
    permissions: {
      filesystem: false,
      network: false,
      process: false,
    },
  },
  adapter: {
    async prepareCommand() {
      return {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      };
    },
  },
};
