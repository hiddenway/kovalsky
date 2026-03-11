"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { getApiClient, resetApiClient } from "@/lib/api/client";
import type { CodexAuthStatus, GatewaySettings, OpenClawProviderMode } from "@/lib/api/contracts";
import { loadPreferences, resetPreferences, savePreferences } from "@/lib/local-state";

type ProviderRecord = {
  id: string;
  provider: "openai" | "codex" | "openclaw";
  label: string;
  createdAt: string;
  keychainRef: string;
};

type CodexAuthMode = "openai_api_key" | "codex_login";
type GatewayStatus = "checking" | "connected" | "disconnected";

type DesktopWindow = Window & {
  kovalskyDesktop?: {
    openExternalUrl?: (url: string) => Promise<boolean>;
  };
};

function parseGatewayBaseUrl(baseUrl: string): { host: string; port: string } {
  try {
    const parsed = new URL(baseUrl);
    return {
      host: parsed.hostname || "127.0.0.1",
      port: parsed.port || "8787",
    };
  } catch {
    return {
      host: "127.0.0.1",
      port: "8787",
    };
  }
}

function buildGatewayBaseUrl(host: string, port: string): string {
  const nextHost = host.trim() || "127.0.0.1";
  const nextPort = port.trim() || "8787";
  return `http://${nextHost}:${nextPort}`;
}

function normalizeHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function ensureGatewayAvailable(baseUrl: string): Promise<void> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Gateway returned HTTP ${response.status}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Gateway connection timeout.");
    }
    throw error instanceof Error ? error : new Error("Failed to reach gateway.");
  } finally {
    window.clearTimeout(timer);
  }
}

export function SettingsPage(): React.JSX.Element {
  const api = getApiClient();
  const [gatewayHost, setGatewayHost] = useState("127.0.0.1");
  const [gatewayPort, setGatewayPort] = useState("8787");
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>("checking");
  const [gatewayMessage, setGatewayMessage] = useState("Checking gateway connection...");
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [codexAuthStatus, setCodexAuthStatus] = useState<CodexAuthStatus | null>(null);
  const [settings, setSettings] = useState<GatewaySettings | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [codexLoginBusy, setCodexLoginBusy] = useState(false);
  const [codexLoginStarted, setCodexLoginStarted] = useState(false);
  const [message, setMessage] = useState("");
  const [codexAuthMode, setCodexAuthMode] = useState<CodexAuthMode>(() => {
    const prefs = loadPreferences();
    return prefs.codexAuthMode === "codex_login" ? "codex_login" : "openai_api_key";
  });
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [openClawMode, setOpenClawMode] = useState<OpenClawProviderMode>("codex");
  const [openClawCustomApiBaseUrl, setOpenClawCustomApiBaseUrl] = useState("");
  const [openClawBusy, setOpenClawBusy] = useState(false);

  const gatewayConnected = gatewayStatus === "connected";

  const connectGateway = async (baseUrl: string, persistOnSuccess: boolean): Promise<boolean> => {
    setGatewayStatus("checking");
    setGatewayMessage("Checking gateway connection...");
    try {
      await ensureGatewayAvailable(baseUrl);
      if (persistOnSuccess) {
        const prefs = loadPreferences();
        savePreferences({
          ...prefs,
          baseUrl,
        });
      }
      resetApiClient();
      setGatewayStatus("connected");
      setGatewayMessage(`Connected to ${baseUrl}`);
      return true;
    } catch (error) {
      setGatewayStatus("disconnected");
      setGatewayMessage(error instanceof Error ? error.message : "Failed to connect to gateway.");
      return false;
    }
  };

  useEffect(() => {
    const prefs = loadPreferences();
    const fromEnv = (process.env.NEXT_PUBLIC_KOVALSKY_BACKEND_URL ?? "").trim().replace(/\/api\/?$/i, "");
    const preferredBaseUrl = (prefs.baseUrl.trim() || fromEnv || "http://127.0.0.1:8787").replace(/\/api\/?$/i, "");
    const fallbackBaseUrl = "http://127.0.0.1:8787";
    const candidates = Array.from(new Set([preferredBaseUrl, fromEnv, fallbackBaseUrl].filter(Boolean)));

    const preferredParsed = parseGatewayBaseUrl(preferredBaseUrl);
    setGatewayHost(preferredParsed.host);
    setGatewayPort(preferredParsed.port);

    void (async () => {
      for (const candidate of candidates) {
        const ok = await connectGateway(candidate, false);
        if (!ok) {
          continue;
        }
        const parsed = parseGatewayBaseUrl(candidate);
        setGatewayHost(parsed.host);
        setGatewayPort(parsed.port);
        return;
      }
    })();
  }, []);

  useEffect(() => {
    if (!gatewayConnected) {
      return;
    }

    let disposed = false;
    void Promise.all([
      api.listProviders(),
      api.getCodexAuthStatus(),
      api.getSettings(),
    ])
      .then(([providerList, codexStatus, settingsPayload]) => {
        if (disposed) {
          return;
        }
        setProviders(providerList);
        setCodexAuthStatus(codexStatus);
        setSettings(settingsPayload);
        setOpenClawMode(settingsPayload.agents.openclaw.providerMode);
        setOpenClawCustomApiBaseUrl(settingsPayload.agents.openclaw.customApiBaseUrl);
      })
      .catch((error) => {
        if (!disposed) {
          setMessage(error instanceof Error ? error.message : "Failed to load settings.");
        }
      });

    return () => {
      disposed = true;
    };
  }, [api, gatewayConnected]);

  useEffect(() => {
    if (!gatewayConnected) {
      return;
    }

    let disposed = false;
    const timer = window.setInterval(() => {
      void api.getCodexAuthStatus()
        .then((status) => {
          if (!disposed) {
            setCodexAuthStatus(status);
          }
        })
        .catch(() => {
          // noop: background refresh
        });
    }, 10_000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [api, gatewayConnected]);

  useEffect(() => {
    if (!gatewayConnected || !codexLoginStarted) {
      return;
    }

    let disposed = false;
    const timer = window.setInterval(() => {
      void api.getCodexAuthStatus()
        .then((status) => {
          if (disposed) {
            return;
          }
          setCodexAuthStatus(status);
          if (status.authenticated) {
            setCodexLoginStarted(false);
            setMessage("Codex login completed.");
          } else if (status.expired) {
            setMessage("Codex session expired. Please login again.");
          }
        })
        .catch(() => {
          // noop: transient polling failures
        });
    }, 1200);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [api, codexLoginStarted, gatewayConnected]);

  const openAiProviders = useMemo(
    () => providers.filter((item) => item.provider === "openai"),
    [providers],
  );

  const persistCodexAuthMode = (nextMode: CodexAuthMode): void => {
    setCodexAuthMode(nextMode);
    const prefs = loadPreferences();
    savePreferences({
      ...prefs,
      codexAuthMode: nextMode,
    });
  };

  const reconnectGateway = async (): Promise<void> => {
    setMessage("");
    const baseUrl = buildGatewayBaseUrl(gatewayHost, gatewayPort);
    const ok = await connectGateway(baseUrl, true);
    setMessage(ok ? `Gateway reconnected: ${baseUrl}` : "Gateway reconnect failed.");
  };

  const resetUiState = (): void => {
    resetPreferences();
    setMessage("UI preferences reset. Reload page to apply defaults.");
  };

  const startCodexLogin = async (): Promise<void> => {
    setCodexLoginBusy(true);
    setMessage("");
    try {
      const login = await api.startCodexLogin();
      setCodexLoginStarted(true);
      const messageParts = ["Codex login started."];
      if (login.deviceCode) {
        messageParts.push(`Verification code: ${login.deviceCode}.`);
      }
      if (login.deviceAuthUrl) {
        const desktopWindow = window as DesktopWindow;
        if (typeof desktopWindow.kovalskyDesktop?.openExternalUrl === "function") {
          await desktopWindow.kovalskyDesktop.openExternalUrl(login.deviceAuthUrl);
        } else {
          window.open(login.deviceAuthUrl, "_blank", "noopener,noreferrer");
        }
        messageParts.push("Complete authentication in the browser tab that was opened.");
      } else {
        messageParts.push("Complete browser auth; this page will update automatically.");
      }
      setMessage(messageParts.join(" "));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to start Codex login.");
    } finally {
      setCodexLoginBusy(false);
    }
  };

  const saveCodexApiKey = async (): Promise<void> => {
    const apiKey = openaiApiKey.trim();
    if (!apiKey) {
      setMessage("Enter OpenAI API key first.");
      return;
    }

    setAuthBusy(true);
    setMessage("");
    try {
      await api.connectProvider({
        provider: "openai",
        apiKey,
        authType: "api_key",
        label: "OpenAI API key",
      });

      const [providerList, codexStatus] = await Promise.all([
        api.listProviders(),
        api.getCodexAuthStatus(),
      ]);
      setProviders(providerList);
      setCodexAuthStatus(codexStatus);
      setOpenaiApiKey("");
      setCodexLoginStarted(false);
      setMessage("OpenAI API key saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save OpenAI API key.");
    } finally {
      setAuthBusy(false);
    }
  };

  const removeOpenAiKeys = async (): Promise<void> => {
    setAuthBusy(true);
    setMessage("");
    try {
      if (openAiProviders.length === 0) {
        setMessage("No OpenAI API key saved.");
        return;
      }

      await Promise.all(openAiProviders.map((item) => api.deleteProvider(item.id)));
      const [providerList, codexStatus] = await Promise.all([
        api.listProviders(),
        api.getCodexAuthStatus(),
      ]);
      setProviders(providerList);
      setCodexAuthStatus(codexStatus);
      setMessage("OpenAI API key removed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to remove OpenAI API key.");
    } finally {
      setAuthBusy(false);
    }
  };

  const removeProvider = async (credentialId: string): Promise<void> => {
    setAuthBusy(true);
    setMessage("");
    try {
      await api.deleteProvider(credentialId);
      const providerList = await api.listProviders();
      setProviders(providerList);
      setMessage("Credential removed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to remove credential.");
    } finally {
      setAuthBusy(false);
    }
  };

  const saveOpenClawSettings = async (): Promise<void> => {
    if (!gatewayConnected) {
      return;
    }

    const normalizedCustomUrl = normalizeHttpUrl(openClawCustomApiBaseUrl);
    if (openClawMode === "custom" && !normalizedCustomUrl) {
      setMessage("Custom API URL must be a valid http(s) URL.");
      return;
    }

    setOpenClawBusy(true);
    setMessage("");
    try {
      const payload = await api.updateSettings({
        agents: {
          openclaw: {
            providerMode: openClawMode,
            customApiBaseUrl: openClawMode === "custom" ? normalizedCustomUrl ?? "" : "",
          },
        },
      });
      setSettings(payload);
      setOpenClawMode(payload.agents.openclaw.providerMode);
      setOpenClawCustomApiBaseUrl(payload.agents.openclaw.customApiBaseUrl);
      setMessage("OpenClaw settings saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save OpenClaw settings.");
    } finally {
      setOpenClawBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 px-6 py-6 text-zinc-100">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Settings</h1>
            <p className="text-sm text-zinc-400">Global gateway and agent configuration</p>
          </div>

          <div className="flex gap-2">
            <Link href="/pipelines" className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Workflows
            </Link>
            <Link href="/runs" className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Runs
            </Link>
            <Link href="/builder" className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Builder
            </Link>
          </div>
        </div>

        <section className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-zinc-400">
              Gateway Host
              <input
                value={gatewayHost}
                onChange={(event) => setGatewayHost(event.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
                placeholder="127.0.0.1"
              />
            </label>
            <label className="text-xs text-zinc-400">
              Gateway Port
              <input
                value={gatewayPort}
                onChange={(event) => setGatewayPort(event.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
                placeholder="8787"
              />
            </label>
            <div className="sm:col-span-2 flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={() => void reconnectGateway()}>
                Save & Reconnect Gateway
              </Button>
              <Button type="button" variant="danger" onClick={resetUiState}>
                Reset UI Preferences
              </Button>
            </div>
            <p className={`sm:col-span-2 text-xs ${gatewayConnected ? "text-emerald-300" : "text-rose-300"}`}>
              {gatewayMessage}
            </p>
          </div>
        </section>

        {gatewayConnected ? (
          <>
            <section className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-zinc-100">Codex Authentication</h2>
                  <p className="mt-1 text-xs text-zinc-400">Switch between API key mode and Codex login mode.</p>
                </div>
                <span className="text-xs text-zinc-500">
                  {codexAuthStatus?.authenticated ? "Codex login: connected" : codexAuthStatus?.expired ? "Codex login: expired" : "Codex login: not connected"}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`rounded-md border px-3 py-1 text-xs ${
                    codexAuthMode === "openai_api_key"
                      ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100"
                      : "border-zinc-700 bg-zinc-900 text-zinc-300"
                  }`}
                  onClick={() => persistCodexAuthMode("openai_api_key")}
                >
                  OpenAI API Key
                </button>
                <button
                  type="button"
                  className={`rounded-md border px-3 py-1 text-xs ${
                    codexAuthMode === "codex_login"
                      ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100"
                      : "border-zinc-700 bg-zinc-900 text-zinc-300"
                  }`}
                  onClick={() => persistCodexAuthMode("codex_login")}
                >
                  Codex Login
                </button>
              </div>

              {codexAuthMode === "openai_api_key" ? (
                <div className="mt-3">
                  <input
                    type="password"
                    value={openaiApiKey}
                    onChange={(event) => {
                      setOpenaiApiKey(event.target.value);
                    }}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
                    placeholder="Paste OpenAI API key"
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button type="button" disabled={authBusy || !openaiApiKey.trim()} onClick={() => void saveCodexApiKey()}>
                      {authBusy ? "Saving..." : "Save API Key"}
                    </Button>
                    {openAiProviders.length > 0 ? (
                      <Button type="button" variant="danger" disabled={authBusy} onClick={() => void removeOpenAiKeys()}>
                        Remove Saved API Key
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="mt-3">
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" disabled={codexLoginBusy} onClick={() => void startCodexLogin()}>
                      {codexLoginBusy ? "Starting..." : codexAuthStatus?.authenticated ? "Login with Another Account" : "Login with Codex"}
                    </Button>
                    {openAiProviders.length > 0 ? (
                      <Button type="button" variant="danger" disabled={authBusy} onClick={() => void removeOpenAiKeys()}>
                        Remove API Key (Use Login Mode)
                      </Button>
                    ) : null}
                  </div>
                  {codexLoginStarted ? (
                    <p className="mt-2 text-xs text-zinc-500">Waiting for successful browser login...</p>
                  ) : null}
                </div>
              )}

              <p className="mt-2 text-xs text-zinc-500">Codex expires at: {codexAuthStatus?.expiresAt ?? "n/a"}</p>
            </section>

            <section className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
              <h2 className="text-base font-semibold text-zinc-100">OpenClaw Agent</h2>
              <p className="mt-1 text-xs text-zinc-400">Choose Codex provider mode or a custom OpenAI-compatible API endpoint.</p>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`rounded-md border px-3 py-1 text-xs ${
                    openClawMode === "codex"
                      ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100"
                      : "border-zinc-700 bg-zinc-900 text-zinc-300"
                  }`}
                  onClick={() => setOpenClawMode("codex")}
                >
                  Codex Provider
                </button>
                <button
                  type="button"
                  className={`rounded-md border px-3 py-1 text-xs ${
                    openClawMode === "custom"
                      ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100"
                      : "border-zinc-700 bg-zinc-900 text-zinc-300"
                  }`}
                  onClick={() => setOpenClawMode("custom")}
                >
                  Custom API URL
                </button>
              </div>

              {openClawMode === "custom" ? (
                <label className="mt-3 block text-xs text-zinc-400">
                  Custom API Base URL
                  <input
                    value={openClawCustomApiBaseUrl}
                    onChange={(event) => setOpenClawCustomApiBaseUrl(event.target.value)}
                    className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
                    placeholder="https://api.example.com/v1"
                  />
                </label>
              ) : null}

              <div className="mt-3">
                <Button type="button" disabled={openClawBusy} onClick={() => void saveOpenClawSettings()}>
                  {openClawBusy ? "Saving..." : "Save OpenClaw Settings"}
                </Button>
              </div>

              <p className="mt-2 text-xs text-zinc-500">
                Current mode: {settings?.agents.openclaw.providerMode ?? openClawMode}
                {settings?.agents.openclaw.customApiBaseUrl
                  ? ` | Custom URL: ${settings.agents.openclaw.customApiBaseUrl}`
                  : ""}
              </p>
            </section>

            <section className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
              <h2 className="text-base font-semibold text-zinc-100">Connected Credentials</h2>
              {providers.length === 0 ? (
                <p className="mt-2 text-xs text-zinc-500">No credentials saved yet.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {providers.map((item) => (
                    <div key={item.id} className="flex items-center justify-between gap-2 rounded border border-zinc-800 px-2 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs text-zinc-200">{item.label} ({item.provider})</p>
                        <p className="truncate text-[11px] text-zinc-500">{item.id}</p>
                      </div>
                      <Button type="button" variant="secondary" disabled={authBusy} onClick={() => void removeProvider(item.id)}>
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}

        {message ? <p className="mt-4 text-xs text-zinc-400">{message}</p> : null}
      </div>
    </div>
  );
}
