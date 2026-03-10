import fs from "node:fs";
import path from "node:path";

export type OpenClawProviderMode = "codex" | "custom";

export interface GatewaySettings {
  agents: {
    openclaw: {
      providerMode: OpenClawProviderMode;
      customApiBaseUrl: string;
    };
  };
}

export interface GatewaySettingsPatch {
  agents?: {
    openclaw?: {
      providerMode?: OpenClawProviderMode;
      customApiBaseUrl?: string;
    };
  };
}

const DEFAULT_SETTINGS: GatewaySettings = {
  agents: {
    openclaw: {
      providerMode: "codex",
      customApiBaseUrl: "",
    },
  },
};

function isObject(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input);
}

export class SettingsService {
  private readonly settingsPath: string;

  constructor(appDataDir: string) {
    this.settingsPath = path.join(appDataDir, "settings.json");
  }

  getSettings(): GatewaySettings {
    return this.readSettings();
  }

  updateSettings(input: GatewaySettingsPatch): GatewaySettings {
    const current = this.readSettings();
    const merged = this.mergeSettings(current, input);
    this.writeSettings(merged);
    return merged;
  }

  private mergeSettings(current: GatewaySettings, patch: GatewaySettingsPatch): GatewaySettings {
    const next = structuredClone(current);
    if (!isObject(patch)) {
      return next;
    }

    const agentsPatch = isObject(patch.agents) ? patch.agents : null;
    const openclawPatch = agentsPatch && isObject(agentsPatch.openclaw) ? agentsPatch.openclaw : null;
    if (!openclawPatch) {
      return next;
    }

    if (openclawPatch.providerMode === "codex" || openclawPatch.providerMode === "custom") {
      next.agents.openclaw.providerMode = openclawPatch.providerMode;
    }

    if (typeof openclawPatch.customApiBaseUrl === "string") {
      next.agents.openclaw.customApiBaseUrl = openclawPatch.customApiBaseUrl.trim();
    }

    return next;
  }

  private readSettings(): GatewaySettings {
    try {
      if (!fs.existsSync(this.settingsPath)) {
        return structuredClone(DEFAULT_SETTINGS);
      }
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, "utf8")) as unknown;
      if (!isObject(raw)) {
        return structuredClone(DEFAULT_SETTINGS);
      }
      const settings = structuredClone(DEFAULT_SETTINGS);
      const agents = isObject(raw.agents) ? raw.agents : null;
      const openclaw = agents && isObject(agents.openclaw) ? agents.openclaw : null;
      if (openclaw?.providerMode === "codex" || openclaw?.providerMode === "custom") {
        settings.agents.openclaw.providerMode = openclaw.providerMode;
      }
      if (typeof openclaw?.customApiBaseUrl === "string") {
        settings.agents.openclaw.customApiBaseUrl = openclaw.customApiBaseUrl.trim();
      }
      return settings;
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  private writeSettings(settings: GatewaySettings): void {
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.writeFileSync(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
}
