"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { getApiClient, resetApiClient } from "@/lib/api/client";
import type { CodexAuthStatus, ToolchainBootstrapStatus } from "@/lib/api/contracts";
import { loadPreferences, savePreferences } from "@/lib/local-state";
import { usePipelineStore } from "@/stores/pipeline-store";
import { useRunStore } from "@/stores/run-store";
import { useToastStore } from "@/stores/toast-store";

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<{ name: string }>;
  kovalskyDesktop?: {
    pickWorkspaceDirectory?: () => Promise<string | null>;
    openExternalUrl?: (url: string) => Promise<boolean>;
  };
};

type ProviderRecord = {
  id: string;
  provider: "openai" | "codex" | "openclaw";
  label: string;
  createdAt: string;
  keychainRef: string;
};

type CodexAuthMode = "openai_api_key" | "codex_login";
type GatewayStatus = "checking" | "connected" | "disconnected";

function statusProgress(status: "ready" | "missing" | "installing" | "error"): number {
  if (status === "ready") {
    return 100;
  }
  if (status === "installing") {
    return 60;
  }
  if (status === "error") {
    return 100;
  }
  return 0;
}

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

async function pickWorkspacePath(): Promise<string | null> {
  const withPicker = window as DirectoryPickerWindow;
  if (typeof withPicker.kovalskyDesktop?.pickWorkspaceDirectory === "function") {
    try {
      const absolutePath = await withPicker.kovalskyDesktop.pickWorkspaceDirectory();
      return absolutePath?.trim() || null;
    } catch {
      return null;
    }
  }

  if (typeof withPicker.showDirectoryPicker === "function") {
    try {
      const directory = await withPicker.showDirectoryPicker();
      const name = directory.name?.trim();
      return name ? `~/${name}` : null;
    } catch {
      return null;
    }
  }

  const value = window.prompt("Workspace folder name in ~/:", "");
  if (value === null) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

export function PipelinesPage(): React.JSX.Element {
  const api = getApiClient();
  const hydrated = usePipelineStore((state) => state.hydrated);
  const pipelines = usePipelineStore((state) => state.pipelines);
  const init = usePipelineStore((state) => state.init);
  const createPipeline = usePipelineStore((state) => state.createPipeline);
  const seedTemplatePipelines = usePipelineStore((state) => state.seedTemplatePipelines);
  const openPipeline = usePipelineStore((state) => state.openPipeline);
  const saveActivePipeline = usePipelineStore((state) => state.saveActivePipeline);
  const updateMetadata = usePipelineStore((state) => state.updateMetadata);
  const deletePipeline = usePipelineStore((state) => state.deletePipeline);
  const duplicatePipeline = usePipelineStore((state) => state.duplicatePipeline);
  const initRuns = useRunStore((state) => state.init);
  const cancelRunsForPipeline = useRunStore((state) => state.cancelRunsForPipeline);
  const [gatewayHost, setGatewayHost] = useState("127.0.0.1");
  const [gatewayPort, setGatewayPort] = useState("8787");
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>("checking");
  const [gatewayMessage, setGatewayMessage] = useState("Checking gateway connection...");
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [bootstrapStatus, setBootstrapStatus] = useState<ToolchainBootstrapStatus | null>(null);
  const [bootstrapBusy, setBootstrapBusy] = useState(false);
  const [bootstrapMessage, setBootstrapMessage] = useState("");
  const [bootstrapContinue, setBootstrapContinue] = useState(false);
  const [didNeedBootstrap, setDidNeedBootstrap] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [codexLoginBusy, setCodexLoginBusy] = useState(false);
  const [codexLoginStarted, setCodexLoginStarted] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [codexAuthMode, setCodexAuthMode] = useState<CodexAuthMode>(() => {
    const prefs = loadPreferences();
    return prefs.codexAuthMode === "codex_login" ? "codex_login" : "openai_api_key";
  });
  const [codexAuthStatus, setCodexAuthStatus] = useState<CodexAuthStatus | null>(null);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [templatesChecked, setTemplatesChecked] = useState(false);

  const pushToast = useToastStore((state) => state.pushToast);
  const gatewayConnected = gatewayStatus === "connected";

  const openBuilderForPipeline = async (pipelineId: string, currentWorkspacePath?: string): Promise<void> => {
    const hasWorkspace = Boolean(currentWorkspacePath?.trim());
    if (!hasWorkspace) {
      const workspacePath = await pickWorkspacePath();
      if (!workspacePath) {
        pushToast({
          title: "Workspace is required",
          description: "Pick a workspace folder before opening this workflow.",
          tone: "error",
        });
        return;
      }

      openPipeline(pipelineId);
      updateMetadata({ workspacePath });
      saveActivePipeline();
      pushToast({
        title: "Workspace selected",
        description: workspacePath,
        tone: "success",
      });
    }

    window.location.href = `/builder?pipelineId=${pipelineId}`;
  };

  const connectGateway = async (baseUrl: string): Promise<boolean> => {
    setGatewayStatus("checking");
    setGatewayMessage("Checking gateway connection...");

    try {
      await ensureGatewayAvailable(baseUrl);

      // Keep API client and detected gateway in sync.
      // Without persisting detected URL, a stale saved URL can cause "Failed to fetch".
      const currentPrefs = loadPreferences();
      savePreferences({
        ...currentPrefs,
        baseUrl,
      });

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

  const submitGatewayTarget = async (): Promise<void> => {
    const baseUrl = buildGatewayBaseUrl(gatewayHost, gatewayPort);
    await connectGateway(baseUrl);
  };

  useEffect(() => {
    const prefs = loadPreferences();
    const fromEnv = (process.env.NEXT_PUBLIC_KOVALSKY_BACKEND_URL ?? "").trim().replace(/\/api\/?$/i, "");
    const isDesktop = typeof (window as DirectoryPickerWindow).kovalskyDesktop?.pickWorkspaceDirectory === "function";
    const preferredBaseUrl = (
      isDesktop
        ? (fromEnv || "http://127.0.0.1:18787")
        : (prefs.baseUrl.trim() || fromEnv || "http://127.0.0.1:8787")
    ).replace(/\/api\/?$/i, "");
    const fallbackBaseUrl = "http://127.0.0.1:8787";
    const candidates = isDesktop
      ? Array.from(new Set([preferredBaseUrl, fromEnv].filter(Boolean)))
      : Array.from(new Set([preferredBaseUrl, fromEnv, fallbackBaseUrl].filter(Boolean)));

    const preferredParsed = parseGatewayBaseUrl(preferredBaseUrl);
    setGatewayHost(preferredParsed.host);
    setGatewayPort(preferredParsed.port);

    void (async () => {
      for (const candidate of candidates) {
        const ok = await connectGateway(candidate);
        if (ok) {
          const parsed = parseGatewayBaseUrl(candidate);
          setGatewayHost(parsed.host);
          setGatewayPort(parsed.port);
          return;
        }
      }
    })();
  }, []);

  useEffect(() => {
    if (!gatewayConnected) {
      return;
    }
    init(null);
  }, [gatewayConnected, init]);

  useEffect(() => {
    if (!gatewayConnected) {
      return;
    }
    initRuns();
  }, [gatewayConnected, initRuns]);

  useEffect(() => {
    if (!gatewayConnected || !hydrated || templatesChecked) {
      return;
    }

    let disposed = false;
    const maybeSeedTemplates = async (): Promise<void> => {
      try {
        const payload = await api.getWorkflowTemplates();
        if (disposed) {
          return;
        }
        const seededCount = seedTemplatePipelines(payload.templates);
        if (seededCount > 0) {
          pushToast({
            title: `Loaded ${seededCount} starter workflow template${seededCount === 1 ? "" : "s"}`,
            tone: "success",
          });
        }
      } catch {
        // ignore template loading failures and keep default workflow
      } finally {
        if (!disposed) {
          setTemplatesChecked(true);
        }
      }
    };

    void maybeSeedTemplates();

    return () => {
      disposed = true;
    };
  }, [api, gatewayConnected, hydrated, pushToast, seedTemplatePipelines, templatesChecked]);

  useEffect(() => {
    if (!gatewayConnected) {
      return;
    }

    let disposed = false;

    const refreshAuth = async (): Promise<void> => {
      try {
        const [list, bootstrap, codexStatus] = await Promise.all([
          api.listProviders(),
          api.getToolchainBootstrapStatus(),
          api.getCodexAuthStatus(),
        ]);
        if (disposed) {
          return;
        }
        setProviders(list);
        setBootstrapStatus(bootstrap);
        setCodexAuthStatus(codexStatus);
        if (!bootstrap.ready) {
          setDidNeedBootstrap(true);
          setBootstrapContinue(false);
        }
        if (codexStatus.expired) {
          setAuthMessage("Codex session expired. Please login again.");
        }
      } catch (error) {
        if (!disposed) {
          setAuthMessage(error instanceof Error ? error.message : "Failed to load provider credentials.");
        }
      } finally {
        if (!disposed) {
          setAuthLoading(false);
        }
      }
    };

    void refreshAuth();
    return () => {
      disposed = true;
    };
  }, [api, gatewayConnected]);

  useEffect(() => {
    if (!gatewayConnected || !bootstrapStatus?.running) {
      return;
    }

    const timer = window.setInterval(() => {
      void api.getToolchainBootstrapStatus()
        .then((next) => {
          setBootstrapStatus(next);
          if (!next.ready) {
            setDidNeedBootstrap(true);
            return;
          }
          if (!next.running) {
            setBootstrapBusy(false);
          }
        })
        .catch((error) => {
          setBootstrapBusy(false);
          setBootstrapMessage(error instanceof Error ? error.message : "Failed to refresh install status.");
        });
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [api, bootstrapStatus?.running, gatewayConnected]);

  useEffect(() => {
    if (!gatewayConnected) {
      return;
    }

    let disposed = false;
    const refreshCodexAuth = async (): Promise<void> => {
      try {
        const status = await api.getCodexAuthStatus();
        if (disposed) {
          return;
        }
        setCodexAuthStatus(status);
        if (status.expired) {
          setAuthMessage("Codex session expired. Please login again.");
        }
      } catch {
        // silent background refresh
      }
    };

    const timer = window.setInterval(() => {
      void refreshCodexAuth();
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
    const pollLoginStatus = async (): Promise<void> => {
      try {
        const status = await api.getCodexAuthStatus();
        if (disposed) {
          return;
        }
        setCodexAuthStatus(status);

        if (status.authenticated) {
          setCodexLoginStarted(false);
          setAuthMessage("Codex login completed.");
          return;
        }

        if (status.expired) {
          setAuthMessage("Codex session expired. Please login again.");
        }
      } catch {
        // ignore transient polling errors
      }
    };

    void pollLoginStatus();
    const timer = window.setInterval(() => {
      void pollLoginStatus();
    }, 1200);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [api, codexLoginStarted, gatewayConnected]);

  const hasCodexAuth = useMemo(
    () => providers.some((item) => item.provider === "codex" || item.provider === "openai")
      || Boolean(codexAuthStatus?.authenticated),
    [codexAuthStatus?.authenticated, providers],
  );
  const openaiProviders = useMemo(
    () => providers.filter((item) => item.provider === "openai"),
    [providers],
  );
  const hasOpenAIApiKey = openaiProviders.length > 0;
  const bootstrapGateRequired = gatewayConnected && !authLoading && !bootstrapContinue && (!!didNeedBootstrap || !bootstrapStatus?.ready);
  const authGateRequired = gatewayConnected && !authLoading && !bootstrapGateRequired && !hasCodexAuth;
  const bootstrapTools = bootstrapStatus?.tools ?? [
    { tool: "codex", packageName: "@openai/codex", command: "codex", status: "missing", source: "none", error: null },
    { tool: "openclaw", packageName: "openclaw", command: "openclaw", status: "missing", source: "none", error: null },
  ];

  const startRequiredAgentInstall = async (): Promise<void> => {
    setBootstrapBusy(true);
    setBootstrapMessage("");
    try {
      const status = await api.installRequiredAgents();
      setBootstrapStatus(status);
      setDidNeedBootstrap(true);
    } catch (error) {
      setBootstrapBusy(false);
      setBootstrapMessage(error instanceof Error ? error.message : "Failed to start required agent install.");
    }
  };

  const startCodexLogin = async (): Promise<void> => {
    setCodexLoginBusy(true);
    setAuthMessage("");
    try {
      const login = await api.startCodexLogin();
      setCodexLoginStarted(true);
      const messageParts = ["Codex login started."];
      if (login.deviceCode) {
        messageParts.push(`Verification code: ${login.deviceCode}.`);
      }
      if (login.deviceAuthUrl) {
        const desktopWindow = window as DirectoryPickerWindow;
        if (typeof desktopWindow.kovalskyDesktop?.openExternalUrl === "function") {
          await desktopWindow.kovalskyDesktop.openExternalUrl(login.deviceAuthUrl);
        } else {
          window.open(login.deviceAuthUrl, "_blank", "noopener,noreferrer");
        }
        messageParts.push("Complete authentication in the browser tab that was opened.");
      } else {
        messageParts.push("Complete browser auth; this dialog will close automatically.");
      }
      setAuthMessage(messageParts.join(" "));
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Failed to start Codex login.");
    } finally {
      setCodexLoginBusy(false);
    }
  };

  const persistCodexAuthMode = (nextMode: CodexAuthMode): void => {
    setCodexAuthMode(nextMode);
    const currentPrefs = loadPreferences();
    savePreferences({
      ...currentPrefs,
      codexAuthMode: nextMode,
    });
  };

  const removeOpenAIKeys = async (): Promise<void> => {
    setAuthBusy(true);
    setAuthMessage("");
    try {
      const targets = providers.filter((item) => item.provider === "openai");
      if (targets.length === 0) {
        setAuthMessage("No OpenAI API key saved.");
        return;
      }

      await Promise.all(targets.map((item) => api.deleteProvider(item.id)));
      const [nextProviders, nextCodexStatus] = await Promise.all([
        api.listProviders(),
        api.getCodexAuthStatus(),
      ]);
      setProviders(nextProviders);
      setCodexAuthStatus(nextCodexStatus);
      setAuthMessage("OpenAI API key removed.");
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Failed to remove OpenAI API key.");
    } finally {
      setAuthBusy(false);
    }
  };

  const saveCodexAuth = async (): Promise<void> => {
    if (codexAuthMode !== "openai_api_key") {
      return;
    }

    const token = openaiApiKey.trim();
    if (!token) {
      setAuthMessage("Enter OpenAI API key first.");
      return;
    }

    setAuthBusy(true);
    setAuthMessage("");

    try {
      await api.connectProvider({
        provider: "openai",
        apiKey: token,
        authType: "api_key",
        label: "OpenAI API key",
      });

      const next = await api.listProviders();
      setProviders(next);
      setOpenaiApiKey("");
      setCodexLoginStarted(false);
      setAuthMessage("Codex credential saved.");
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Failed to save credential.");
    } finally {
      setAuthBusy(false);
    }
  };

  if (gatewayConnected && !hydrated) {
    return <div className="flex h-screen items-center justify-center text-zinc-400">Loading workflows...</div>;
  }

  return (
    <div className="min-h-screen bg-zinc-950 px-6 py-6 text-zinc-100">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Workflows</h1>
            <p className="text-sm text-zinc-400">Manage saved workflows</p>
          </div>

          <div className="flex gap-2">
            <Link href="/runs" className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Runs
            </Link>
            <Link href="/settings" className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Settings
            </Link>
            <Link href="/builder" className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Builder
            </Link>
            <Button
              type="button"
              onClick={async () => {
                const workspacePath = await pickWorkspacePath();
                if (workspacePath === null) {
                  return;
                }
                const id = createPipeline(workspacePath);
                pushToast({
                  title: "New workflow created",
                  tone: "success",
                });
                window.location.href = `/builder?pipelineId=${id}`;
              }}
            >
              New
            </Button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pipelines
            .slice()
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .map((pipeline) => (
              <article key={pipeline.id} className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
                <h2 className="line-clamp-1 text-base font-semibold">{pipeline.name}</h2>
                <p className="mt-1 truncate text-xs text-zinc-500">Workspace: {pipeline.workspacePath?.trim() || "not set"}</p>
                <p className="mt-2 text-xs text-zinc-400">Updated {new Date(pipeline.updatedAt).toLocaleString()}</p>
                <p className="mt-1 text-xs text-zinc-500">
                  Nodes: {pipeline.nodes.length} | Edges: {pipeline.edges.length}
                </p>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-cyan-400/50 bg-cyan-500/20 px-3 py-1.5 text-sm text-cyan-100 hover:bg-cyan-500/30"
                    onClick={() => {
                      void openBuilderForPipeline(pipeline.id, pipeline.workspacePath);
                    }}
                  >
                    Open
                  </button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      duplicatePipeline(pipeline.id);
                      pushToast({
                        title: "Workflow duplicated",
                        tone: "success",
                      });
                    }}
                  >
                    Duplicate
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={async () => {
                      const canceled = await cancelRunsForPipeline(pipeline.id);
                      deletePipeline(pipeline.id);
                      pushToast({
                        title: canceled > 0 ? `Workflow deleted • canceled ${canceled} run(s)` : "Workflow deleted",
                        tone: canceled > 0 ? "success" : "info",
                      });
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </article>
            ))}
        </div>
      </div>

      {!gatewayConnected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-xl rounded-xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="text-lg font-semibold text-zinc-100">Waiting for Gateway</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Connect frontend to gateway before loading workflows.
            </p>

            <form
              className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_140px]"
              onSubmit={(event) => {
                event.preventDefault();
                void submitGatewayTarget();
              }}
            >
              <label className="text-xs text-zinc-400">
                Host
                <input
                  value={gatewayHost}
                  onChange={(event) => setGatewayHost(event.target.value)}
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
                  placeholder="127.0.0.1"
                />
              </label>
              <label className="text-xs text-zinc-400">
                Port
                <input
                  value={gatewayPort}
                  onChange={(event) => setGatewayPort(event.target.value)}
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
                  placeholder="8787"
                />
              </label>
              <div className="sm:col-span-2 flex items-center gap-2">
                <Button type="submit" disabled={gatewayStatus === "checking"}>
                  {gatewayStatus === "checking" ? "Checking..." : "Connect"}
                </Button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
                  onClick={() => {
                    void connectGateway(buildGatewayBaseUrl(gatewayHost, gatewayPort));
                  }}
                >
                  Retry
                </button>
              </div>
            </form>

            <p className={`mt-3 text-xs ${gatewayStatus === "disconnected" ? "text-rose-300" : "text-zinc-400"}`}>
              {gatewayMessage}
            </p>
          </div>
        </div>
      ) : null}

      {bootstrapGateRequired ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl rounded-xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="text-lg font-semibold text-zinc-100">Install Required Agents</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Gateway will install local runtimes before you connect credentials.
            </p>

            <div className="mt-4 space-y-3">
              {bootstrapTools.map((tool) => {
                const progress = statusProgress(tool.status);
                const isError = tool.status === "error";
                const label = tool.tool === "codex" ? "Codex" : "OpenClaw";
                return (
                  <div key={tool.tool} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-zinc-200">{label}</p>
                      <span
                        className={`text-xs ${
                          isError
                            ? "text-rose-300"
                            : tool.status === "ready"
                              ? "text-emerald-300"
                              : "text-zinc-400"
                        }`}
                      >
                        {tool.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-500">pnpm add {tool.packageName}</p>
                    <div className="mt-2 h-2 w-full overflow-hidden rounded bg-zinc-800">
                      <div
                        className={`h-full ${
                          isError
                            ? "bg-rose-500/80"
                            : tool.status === "ready"
                              ? "bg-emerald-500/80"
                              : "bg-cyan-500/80"
                        } ${tool.status === "installing" ? "animate-pulse" : ""}`}
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    {tool.error ? <p className="mt-2 text-xs text-rose-300">{tool.error}</p> : null}
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {bootstrapStatus?.ready ? (
                <Button type="button" onClick={() => setBootstrapContinue(true)}>
                  Continue
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={bootstrapBusy || bootstrapStatus?.running}
                  onClick={() => void startRequiredAgentInstall()}
                >
                  {bootstrapStatus?.running ? "Installing..." : "Install Required Agents"}
                </Button>
              )}
            </div>

            {bootstrapMessage ? <p className="mt-3 text-xs text-zinc-400">{bootstrapMessage}</p> : null}
          </div>
        </div>
      ) : null}

      {authGateRequired ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl rounded-xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="text-lg font-semibold text-zinc-100">Connect Required Agents</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Connect Codex to continue. You can use OpenAI API key or Codex login.
            </p>

            <div className="mt-4 space-y-4">
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="text-sm font-semibold text-zinc-200">Codex</p>

                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className={`rounded-md border px-3 py-1 text-xs ${
                      codexAuthMode === "openai_api_key"
                        ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100"
                        : "border-zinc-700 bg-zinc-900 text-zinc-300"
                    }`}
                    onClick={() => {
                      persistCodexAuthMode("openai_api_key");
                    }}
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
                    onClick={() => {
                      persistCodexAuthMode("codex_login");
                    }}
                  >
                    Codex Login
                  </button>
                </div>

                {codexAuthMode === "codex_login" ? (
                  <div className="mt-2 text-xs text-zinc-400">
                    <Button type="button" disabled={codexLoginBusy} onClick={() => void startCodexLogin()}>
                      {codexLoginBusy ? "Starting..." : codexAuthStatus?.authenticated ? "Login with Another Account" : "Login"}
                    </Button>
                    {hasOpenAIApiKey ? (
                      <div className="mt-2">
                        <Button
                          type="button"
                          variant="danger"
                          disabled={authBusy}
                          onClick={() => void removeOpenAIKeys()}
                        >
                          Remove API Key (Use Login Mode)
                        </Button>
                      </div>
                    ) : null}
                    {codexLoginStarted ? (
                      <p className="mt-2 text-zinc-500">Waiting for successful browser login...</p>
                    ) : null}
                    {codexAuthStatus?.expired ? (
                      <p className="mt-2 text-amber-300">Codex token expired. Please login again.</p>
                    ) : null}
                  </div>
                ) : null}

                {codexAuthMode === "openai_api_key" ? (
                  <input
                    type="password"
                    value={openaiApiKey}
                    onChange={(event) => {
                      setOpenaiApiKey(event.target.value);
                    }}
                    className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
                    placeholder="Paste OpenAI API key"
                  />
                ) : null}

                {codexAuthMode === "openai_api_key" ? (
                  <div className="mt-2">
                    <Button
                      type="button"
                      disabled={authBusy || !openaiApiKey.trim()}
                      onClick={() => void saveCodexAuth()}
                    >
                      {authBusy ? "Saving..." : "Save Codex Auth"}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>

            {authMessage ? <p className="mt-3 text-xs text-zinc-400">{authMessage}</p> : null}
            <p className="mt-2 text-xs text-zinc-500">Credentials are global and shared across all workflows.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
