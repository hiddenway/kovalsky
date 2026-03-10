import type {
  AgentDefinition,
  Pipeline,
} from "@/lib/types";

export type CreateRunRequest = {
  pipelineId: string;
  overrides?: {
    workspacePath?: string;
    clearNodeChatContext?: boolean;
  };
};

export type CreateRunResponse = {
  runId: string;
};

export type GatewayPipelineGraph = {
  nodes: Array<{
    id: string;
    agentId: string;
    goal?: string;
    settings?: Record<string, unknown>;
    position?: { x: number; y: number };
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
  }>;
};

export type GatewayPipelineResponse = {
  id: string;
  name: string;
  graph: GatewayPipelineGraph;
  createdAt: string;
  updatedAt: string;
};

export type GatewayRunSnapshot = {
  run: {
    id: string;
    pipeline_id: string;
    status: "queued" | "running" | "success" | "failed" | "canceled";
    started_at: string | null;
    finished_at: string | null;
    error_summary: string | null;
  } | null;
  stepRuns: Array<{
    id: string;
    run_id: string;
    node_id: string;
    agent_id: string;
    status: "pending" | "running" | "success" | "failed" | "skipped" | "canceled";
    started_at: string | null;
    finished_at: string | null;
    exit_code: number | null;
    error_summary: string | null;
  }>;
  artifacts: Array<{
    id: string;
    run_id: string;
    produced_by_step_run_id: string;
    type: string;
    title: string;
    path: string;
    mime: string;
    size: number;
    created_at: string;
    meta_json: string | null;
  }>;
  plan: unknown;
};

export type ToolchainBootstrapTool = {
  tool: "codex" | "openclaw";
  packageName: string;
  command: string;
  status: "ready" | "missing" | "installing" | "error";
  source: "system" | "local" | "none";
  error: string | null;
};

export type ToolchainBootstrapStatus = {
  runtimeMode: "auto" | "system";
  running: boolean;
  ready: boolean;
  tools: ToolchainBootstrapTool[];
};

export type CodexAuthStatus = {
  authenticated: boolean;
  expired: boolean;
  expiresAt: string | null;
};

export type OpenClawProviderMode = "codex" | "custom";

export type GatewaySettings = {
  agents: {
    openclaw: {
      providerMode: OpenClawProviderMode;
      customApiBaseUrl: string;
    };
  };
};

export type GatewaySettingsPatch = {
  agents?: {
    openclaw?: {
      providerMode?: OpenClawProviderMode;
      customApiBaseUrl?: string;
    };
  };
};

export interface KovalskyApiClient {
  getAgents(): Promise<AgentDefinition[]>;
  createPipeline(pipeline: Pipeline): Promise<{ pipelineId: string }>;
  getPipeline(id: string): Promise<GatewayPipelineResponse | null>;
  updatePipeline(pipeline: Pipeline): Promise<{ pipelineId: string }>;
  createRun(request: CreateRunRequest): Promise<CreateRunResponse>;
  getRun(runId: string): Promise<GatewayRunSnapshot | null>;
  cancelRun(runId: string): Promise<{ ok: boolean }>;
  getStepLogs(runId: string, stepRunId: string, tail?: number): Promise<{ lines: string[] }>;
  getArtifactPreview(artifactId: string): Promise<{
    id: string;
    type: string;
    title: string;
    mime: string;
    preview: string;
    meta: Record<string, unknown> | null;
  }>;
  getNodeChat(runId: string, nodeId: string): Promise<{
    runId: string;
    nodeId: string;
    messages: Array<{
      id: string;
      run_id: string;
      node_id: string;
      role: "user" | "agent" | "system";
      phase: "pre_run" | "run";
      content: string;
      created_at: string;
      meta_json: string | null;
    }>;
  }>;
  appendNodeChat(
    runId: string,
    nodeId: string,
    input: {
      content: string;
      role?: "user" | "agent" | "system";
      phase?: "pre_run" | "run";
      meta?: Record<string, unknown>;
    },
  ): Promise<{
    ok: boolean;
    message: {
      id: string;
      run_id: string;
      node_id: string;
      role: "user" | "agent" | "system";
      phase: "pre_run" | "run";
      content: string;
      created_at: string;
      meta_json: string | null;
    };
  }>;
  replyNodeChat(
    runId: string,
    nodeId: string,
    input: {
      content: string;
      rerunMode?: "node" | "pipeline";
    },
  ): Promise<{
    ok: boolean;
    userMessage: {
      id: string;
      run_id: string;
      node_id: string;
      role: "user" | "agent" | "system";
      phase: "pre_run" | "run";
      content: string;
      created_at: string;
      meta_json: string | null;
    };
    message: {
      id: string;
      run_id: string;
      node_id: string;
      role: "user" | "agent" | "system";
      phase: "pre_run" | "run";
      content: string;
      created_at: string;
      meta_json: string | null;
    };
  }>;
  listProviders(): Promise<Array<{
    id: string;
    provider: "openai" | "codex" | "openclaw";
    label: string;
    createdAt: string;
    keychainRef: string;
  }>>;
  connectProvider(input: {
    provider: "openai" | "codex" | "openclaw";
    apiKey: string;
    label?: string;
    authType?: "api_key" | "oauth";
  }): Promise<{ credentialId: string }>;
  deleteProvider(credentialId: string): Promise<{ ok: boolean }>;
  getProviderOAuthUrl(provider: "codex" | "openclaw"): Promise<{ provider: "codex" | "openclaw"; oauthUrl: string }>;
  getToolchainBootstrapStatus(): Promise<ToolchainBootstrapStatus>;
  installRequiredAgents(): Promise<ToolchainBootstrapStatus>;
  startCodexLogin(): Promise<{ ok: boolean }>;
  getCodexAuthStatus(): Promise<CodexAuthStatus>;
  getSettings(): Promise<GatewaySettings>;
  updateSettings(input: GatewaySettingsPatch): Promise<GatewaySettings>;
}
