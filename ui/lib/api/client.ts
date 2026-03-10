import { getSupportedAgents } from "@/lib/agents";
import type { CreateRunRequest, GatewayPipelineGraph, GatewaySettingsPatch, KovalskyApiClient } from "@/lib/api/contracts";
import { loadPreferences } from "@/lib/local-state";
import type { Pipeline } from "@/lib/types";

function toGatewayGraph(pipeline: Pipeline): GatewayPipelineGraph {
  return {
    nodes: pipeline.nodes.map((node) => ({
      id: node.id,
      agentId: node.data.agentId,
      goal: node.data.goal,
      settings: node.data.settings,
      position: node.position ? { x: node.position.x, y: node.position.y } : undefined,
    })),
    edges: pipeline.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })),
  };
}

class RestKovalskyApiClient implements KovalskyApiClient {
  private tokenPromise: Promise<string> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly initialToken: string,
  ) {}

  private buildUrl(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private candidatePaths(path: string): string[] {
    const prefixed = path.startsWith("/api/") ? path : `/api${path}`;
    const plain = path.replace(/^\/api/, "");
    return Array.from(new Set([plain, prefixed]));
  }

  private async fetchWithFallback(path: string, init?: RequestInit): Promise<Response> {
    let last404: Response | null = null;
    const requestInit = await this.withAuth(init);

    for (const candidatePath of this.candidatePaths(path)) {
      const response = await fetch(this.buildUrl(candidatePath), requestInit);
      if (response.status === 404) {
        last404 = response;
        continue;
      }
      return response;
    }

    if (last404) {
      return last404;
    }

    return fetch(this.buildUrl(path), requestInit);
  }

  private async throwHttpError(response: Response, fallbackMessage: string): Promise<never> {
    const body = (await response.text().catch(() => "")).trim();
    const details = body ? `: ${body}` : "";
    throw new Error(`${fallbackMessage} (HTTP ${response.status}${details})`);
  }

  private async withAuth(init?: RequestInit): Promise<RequestInit> {
    const token = await this.resolveToken();
    const headers = new Headers(init?.headers ?? {});
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    return {
      ...init,
      headers,
    };
  }

  private async resolveToken(): Promise<string> {
    if (this.initialToken.trim()) {
      return this.initialToken.trim();
    }

    if (!this.tokenPromise) {
      this.tokenPromise = this.loadTokenFromNextRoute();
    }
    return this.tokenPromise;
  }

  private async loadTokenFromNextRoute(): Promise<string> {
    try {
      const response = await fetch("/api/pairing-token", {
        method: "GET",
        cache: "no-store",
      });
      if (!response.ok) {
        return "";
      }
      const payload = (await response.json()) as { token?: string };
      return (payload.token ?? "").trim();
    } catch {
      return "";
    }
  }

  async getAgents() {
    const response = await this.fetchWithFallback("/agents", {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to load agents");
    }

    const raw = (await response.json()) as Awaited<ReturnType<KovalskyApiClient["getAgents"]>>;
    return getSupportedAgents(raw);
  }

  async createPipeline(pipeline: Pipeline) {
    const response = await this.fetchWithFallback("/pipelines", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: pipeline.id,
        name: pipeline.name,
        graph: toGatewayGraph(pipeline),
      }),
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to persist workflow");
    }

    return (await response.json()) as { pipelineId: string };
  }

  async getPipeline(id: string) {
    const response = await this.fetchWithFallback(`/pipelines/${id}`, {
      method: "GET",
      cache: "no-store",
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to load workflow");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["getPipeline"]>>;
  }

  async updatePipeline(pipeline: Pipeline) {
    const response = await this.fetchWithFallback(`/pipelines/${pipeline.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: pipeline.name,
        graph: toGatewayGraph(pipeline),
      }),
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to persist workflow");
    }

    return (await response.json()) as { pipelineId: string };
  }

  async createRun(request: CreateRunRequest) {
    const response = await this.fetchWithFallback("/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to create run");
    }

    return (await response.json()) as { runId: string };
  }

  async getRun(runId: string) {
    const response = await this.fetchWithFallback(`/runs/${runId}`, {
      method: "GET",
      cache: "no-store",
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to load run");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["getRun"]>>;
  }

  async cancelRun(runId: string) {
    const response = await this.fetchWithFallback(`/runs/${runId}/cancel`, {
      method: "POST",
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to cancel run");
    }

    return (await response.json()) as { ok: boolean };
  }

  async getStepLogs(runId: string, stepRunId: string, tail = 200) {
    const response = await this.fetchWithFallback(`/runs/${runId}/steps/${stepRunId}/logs?tail=${tail}`, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to load step logs");
    }

    return (await response.json()) as { lines: string[] };
  }

  async getArtifactPreview(artifactId: string) {
    const response = await this.fetchWithFallback(`/artifacts/${artifactId}/preview`, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to load artifact preview");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["getArtifactPreview"]>>;
  }

  async getNodeChat(runId: string, nodeId: string) {
    const response = await this.fetchWithFallback(`/runs/${runId}/nodes/${nodeId}/chat`, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to load node chat");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["getNodeChat"]>>;
  }

  async appendNodeChat(
    runId: string,
    nodeId: string,
    input: { content: string; role?: "user" | "agent" | "system"; phase?: "pre_run" | "run"; meta?: Record<string, unknown> },
  ) {
    const response = await this.fetchWithFallback(`/runs/${runId}/nodes/${nodeId}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to append node chat");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["appendNodeChat"]>>;
  }

  async replyNodeChat(
    runId: string,
    nodeId: string,
    input: {
      content: string;
      rerunMode?: "node" | "pipeline";
    },
  ) {
    const response = await this.fetchWithFallback(`/runs/${runId}/nodes/${nodeId}/chat/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to generate node chat reply");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["replyNodeChat"]>>;
  }

  async listProviders() {
    const response = await this.fetchWithFallback("/providers", {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to load providers");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["listProviders"]>>;
  }

  async connectProvider(input: {
    provider: "openai" | "codex" | "openclaw";
    apiKey: string;
    label?: string;
    authType?: "api_key" | "oauth";
  }) {
    const response = await this.fetchWithFallback("/providers/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to connect provider");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["connectProvider"]>>;
  }

  async deleteProvider(credentialId: string) {
    const response = await this.fetchWithFallback(`/providers/${credentialId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to delete provider");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["deleteProvider"]>>;
  }

  async getProviderOAuthUrl(provider: "codex" | "openclaw") {
    const response = await this.fetchWithFallback(`/providers/${provider}/oauth-url`, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to load provider OAuth URL");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["getProviderOAuthUrl"]>>;
  }

  async getToolchainBootstrapStatus() {
    const response = await this.fetchWithFallback("/toolchain/agents", {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to load toolchain status");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["getToolchainBootstrapStatus"]>>;
  }

  async installRequiredAgents() {
    const response = await this.fetchWithFallback("/toolchain/agents/install", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to start required agents install");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["installRequiredAgents"]>>;
  }

  async startCodexLogin() {
    const response = await this.fetchWithFallback("/toolchain/codex/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to start Codex login");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["startCodexLogin"]>>;
  }

  async getCodexAuthStatus() {
    const response = await this.fetchWithFallback("/toolchain/codex/auth", {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to load Codex auth status");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["getCodexAuthStatus"]>>;
  }

  async getSettings() {
    const response = await this.fetchWithFallback("/settings", {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to load settings");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["getSettings"]>>;
  }

  async updateSettings(input: GatewaySettingsPatch) {
    const response = await this.fetchWithFallback("/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      await this.throwHttpError(response, "Failed to update settings");
    }

    return (await response.json()) as Awaited<ReturnType<KovalskyApiClient["updateSettings"]>>;
  }
}

let sharedClient: KovalskyApiClient | null = null;

export function resetApiClient(): void {
  sharedClient = null;
}

export function getApiClient(): KovalskyApiClient {
  if (sharedClient) {
    return sharedClient;
  }

  const fromEnv = process.env.NEXT_PUBLIC_KOVALSKY_BACKEND_URL?.trim();
  const prefs = typeof window !== "undefined" ? loadPreferences() : null;
  const fromPrefs = prefs?.baseUrl.trim() ?? "";
  const tokenFromPrefs = prefs?.token.trim() ?? "";
  const tokenFromEnv = process.env.NEXT_PUBLIC_KOVALSKY_PAIRING_TOKEN?.trim() ?? "";
  const backendUrl = (fromPrefs || fromEnv || "http://127.0.0.1:8787").replace(/\/api\/?$/i, "");
  const pairingToken = tokenFromEnv || tokenFromPrefs;

  sharedClient = new RestKovalskyApiClient(backendUrl, pairingToken);
  return sharedClient;
}
