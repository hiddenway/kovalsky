import { openclawPlugin } from "./openclaw";
import type { AgentPlugin } from "../types";

export const triggerPlugin: AgentPlugin = {
  manifest: {
    ...openclawPlugin.manifest,
    id: "trigger",
    title: "Trigger",
    configSchema: {
      type: "object",
      properties: {
        ...(openclawPlugin.manifest.configSchema?.properties ?? {}),
        trigger: {
          type: "object",
        },
      },
    },
  },
  adapter: openclawPlugin.adapter,
};
