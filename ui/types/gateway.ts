export interface AgentSummary {
  id: string;
  version: string;
  title: string;
  runner: string;
  inputs: Array<{ type: string; required?: boolean; multi?: boolean }>;
  outputs: Array<{ type: string }>;
  permissions?: { filesystem?: boolean; network?: boolean; process?: boolean };
}

export interface GraphNodePayload {
  id: string;
  agentId: string;
  goal?: string;
  settings?: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface GraphEdgePayload {
  id: string;
  source: string;
  target: string;
}

export interface PipelineGraphPayload {
  nodes: GraphNodePayload[];
  edges: GraphEdgePayload[];
}

export interface RunSnapshot {
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
    status: string;
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
  plan: RunPlanData | null;
}

export interface RunPlanData {
  runId: string;
  pipelineId: string;
  createdAt: string;
  isExecutable: boolean;
  nodes: Array<{
    nodeId: string;
    agentId: string;
    goal: string;
    goalAddendum?: string;
    handoffContext?: string;
    receivesFrom: string[];
    handoffTo: Array<{
      nodeId: string;
      context: string;
      launchHints: string[];
    }>;
    notes: string[];
  }>;
  issues: Array<{
    severity: "error" | "warning";
    code: string;
    nodeId: string;
    inputType: string;
    message: string;
  }>;
}

export interface NodeMessage {
  id: string;
  run_id: string;
  node_id: string;
  role: "user" | "agent" | "system";
  phase: "pre_run" | "run";
  content: string;
  created_at: string;
  meta_json: string | null;
}

export interface GatewayEvent {
  runId: string;
  type:
    | "run_status"
    | "step_status"
    | "log_line"
    | "progress"
    | "artifact_created"
    | "plan_finalized"
    | "chat_message"
    | "error";
  payload: Record<string, unknown>;
  at: string;
}
