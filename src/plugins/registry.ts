import fs from "node:fs";
import path from "node:path";
import { DatabaseService } from "../db";
import { codexPlugin } from "./builtin/codex";
import { openclawPlugin } from "./builtin/openclaw";
import { triggerPlugin } from "./builtin/trigger";
import { loopPlugin } from "./builtin/loop";
import type { AgentPlugin } from "./types";
import type { AgentManifest } from "../types";

export class PluginRegistry {
  private readonly plugins = new Map<string, AgentPlugin>();

  constructor(
    private readonly db: DatabaseService,
    private readonly pluginsDir: string,
  ) {}

  async loadAll(): Promise<void> {
    this.registerBuiltin(codexPlugin);
    this.registerBuiltin(openclawPlugin);
    this.registerBuiltin(triggerPlugin);
    this.registerBuiltin(loopPlugin);
    await this.loadFromPluginsDir();
  }

  get(agentId: string): AgentPlugin | undefined {
    return this.plugins.get(agentId);
  }

  listManifests(): AgentManifest[] {
    return [...this.plugins.values()].map((plugin) => plugin.manifest);
  }

  private registerBuiltin(plugin: AgentPlugin): void {
    this.plugins.set(plugin.manifest.id, plugin);
    this.db.upsertAgent({
      id: plugin.manifest.id,
      version: plugin.manifest.version,
      title: plugin.manifest.title,
      runnerType: plugin.manifest.runner,
      manifestJson: JSON.stringify(plugin.manifest),
    });
  }

  private async loadFromPluginsDir(): Promise<void> {
    if (!fs.existsSync(this.pluginsDir)) {
      return;
    }

    const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());

    for (const entry of entries) {
      const pluginDir = path.join(this.pluginsDir, entry.name);
      const manifestPath = path.join(pluginDir, "manifest.json");
      const adapterPath = path.join(pluginDir, "adapter.js");

      if (!fs.existsSync(manifestPath) || !fs.existsSync(adapterPath)) {
        continue;
      }

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as AgentManifest;
        const module = require(adapterPath);
        const adapter = module.default ?? module.adapter;

        if (!adapter) {
          continue;
        }

        const plugin: AgentPlugin = {
          manifest,
          adapter,
        };

        this.plugins.set(manifest.id, plugin);
        this.db.upsertAgent({
          id: manifest.id,
          version: manifest.version,
          title: manifest.title,
          runnerType: manifest.runner,
          manifestJson: JSON.stringify(manifest),
        });
      } catch {
        // skip invalid plugin and continue bootstrap
      }
    }
  }
}
