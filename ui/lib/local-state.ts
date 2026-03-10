export interface UiPreferences {
  baseUrl: string;
  token: string;
  workspacePath: string;
  codexAuthMode?: "openai_api_key" | "codex_login";
}

const KEY = "kovalsky_gateway_ui_prefs_v1";

export function loadPreferences(): UiPreferences {
  if (typeof window === "undefined") {
    return {
      baseUrl: "",
      token: "",
      workspacePath: "",
    };
  }

  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) {
      return {
        baseUrl: "",
        token: "",
        workspacePath: "",
        codexAuthMode: undefined,
      };
    }
    const parsed = JSON.parse(raw) as Partial<UiPreferences>;
    return {
      baseUrl: parsed.baseUrl || "",
      token: parsed.token || "",
      workspacePath: parsed.workspacePath || "",
      codexAuthMode: parsed.codexAuthMode === "codex_login" ? "codex_login" : parsed.codexAuthMode === "openai_api_key" ? "openai_api_key" : undefined,
    };
  } catch {
    return {
      baseUrl: "",
      token: "",
      workspacePath: "",
      codexAuthMode: undefined,
    };
  }
}

export function savePreferences(value: UiPreferences): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(KEY, JSON.stringify(value));
}

export function resetPreferences(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(KEY);
}
