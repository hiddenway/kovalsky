import type {
  AgentSummary,
  GatewayEvent,
  NodeMessage,
  PipelineGraphPayload,
  RunPlanData,
  RunSnapshot,
} from "@/types/gateway";

export class GatewayApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private buildUrl(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.buildUrl(path), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body}`);
    }

    return response.json() as Promise<T>;
  }

  async health(): Promise<{ ok: boolean; version: string }> {
    const response = await fetch(this.buildUrl("/health"), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }
    return response.json() as Promise<{ ok: boolean; version: string }>;
  }

  listAgents(): Promise<AgentSummary[]> {
    return this.request<AgentSummary[]>("/agents", { method: "GET" });
  }

  createPipeline(input: { name: string; graph: PipelineGraphPayload }): Promise<{ pipelineId: string }> {
    return this.request<{ pipelineId: string }>("/pipelines", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  getPipeline(pipelineId: string): Promise<{ id: string; name: string; graph: PipelineGraphPayload }> {
    return this.request<{ id: string; name: string; graph: PipelineGraphPayload }>(`/pipelines/${pipelineId}`, {
      method: "GET",
    });
  }

  updatePipeline(pipelineId: string, input: { name: string; graph: PipelineGraphPayload }): Promise<{ pipelineId: string }> {
    return this.request<{ pipelineId: string }>(`/pipelines/${pipelineId}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  startRun(input: {
    pipelineId: string;
    overrides: {
      workspacePath: string;
      maxParallelSteps?: number;
      stopOnFailure?: boolean;
      timeoutMs?: number;
      credentialId?: string;
      preserveNodeChatContext?: boolean;
    };
  }): Promise<{ runId: string }> {
    return this.request<{ runId: string }>("/runs", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  cancelRun(runId: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/runs/${runId}/cancel`, {
      method: "POST",
    });
  }

  getRun(runId: string): Promise<RunSnapshot> {
    return this.request<RunSnapshot>(`/runs/${runId}`, {
      method: "GET",
    });
  }

  getArtifactPreview(artifactId: string): Promise<{
    id: string;
    type: string;
    title: string;
    mime: string;
    preview: string;
    meta: Record<string, unknown> | null;
  }> {
    return this.request(`/artifacts/${artifactId}/preview`, {
      method: "GET",
    });
  }

  getRunPlan(runId: string): Promise<RunPlanData> {
    return this.request<RunPlanData>(`/runs/${runId}/plan`, {
      method: "GET",
    });
  }

  getNodeChat(runId: string, nodeId: string): Promise<{ runId: string; nodeId: string; messages: NodeMessage[] }> {
    return this.request<{ runId: string; nodeId: string; messages: NodeMessage[] }>(`/runs/${runId}/nodes/${nodeId}/chat`, {
      method: "GET",
    });
  }

  appendNodeChat(input: {
    runId: string;
    nodeId: string;
    content: string;
    role?: "user" | "agent" | "system";
    phase?: "pre_run" | "run";
  }): Promise<{ ok: boolean; message: NodeMessage }> {
    return this.request<{ ok: boolean; message: NodeMessage }>(`/runs/${input.runId}/nodes/${input.nodeId}/chat`, {
      method: "POST",
      body: JSON.stringify({
        content: input.content,
        role: input.role,
        phase: input.phase,
      }),
    });
  }

  getStepLogs(runId: string, stepRunId: string, tail = 200): Promise<{ lines: string[] }> {
    return this.request<{ lines: string[] }>(`/runs/${runId}/steps/${stepRunId}/logs?tail=${tail}`, {
      method: "GET",
    });
  }

  connectRunStream(runId: string, onEvent: (event: GatewayEvent) => void): WebSocket {
    const wsBase = this.baseUrl
      .replace(/^http:\/\//i, "ws://")
      .replace(/^https:\/\//i, "wss://")
      .replace(/\/$/, "");

    const url = `${wsBase}/stream?runId=${encodeURIComponent(runId)}&token=${encodeURIComponent(this.token)}`;
    const socket = new WebSocket(url);

    socket.onmessage = (message) => {
      try {
        const parsed = JSON.parse(message.data as string) as GatewayEvent;
        onEvent(parsed);
      } catch {
        // ignore invalid events
      }
    };

    return socket;
  }
}
