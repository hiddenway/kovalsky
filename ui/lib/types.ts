import type { Edge, Node } from "reactflow";

export type AgentDefinition = {
  id: string;
  title: string;
  description: string;
  icon?: string;
  inputs?: string[];
  outputs?: string[];
  configSchema?: unknown;
};

export type PipelineNodeData = {
  agentId: string;
  customName?: string;
  goal: string;
  settings?: Record<string, unknown>;
  runtimeStatus?: StepStatus;
  runtimeStatusLabel?: string;
  handoff?: {
    status: StepStatus;
    summary: string;
    comments: string[];
    results: string[];
    finalReport: string;
  };
  onOpenHandoff?: () => void;
};

export type ReactFlowNode<T = PipelineNodeData> = Node<T>;
export type ReactFlowEdge = Edge;

export type Pipeline = {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  workspacePath?: string;
  chatRerunMode?: "node" | "pipeline";
  preserveNodeChatContextOnRun?: boolean;
  nodes: ReactFlowNode<PipelineNodeData>[];
  edges: ReactFlowEdge[];
  updatedAt: string;
};

export type RunStatus = "queued" | "running" | "success" | "failed" | "canceled";
export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped" | "canceled";

export type Run = {
  id: string;
  pipelineId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
};

export type Artifact = {
  id: string;
  type: string;
  title: string;
  mime?: string;
  preview?: string;
  url?: string;
  createdAt: string;
  details?: Record<string, unknown>;
};

export type StepRun = {
  stepId: string;
  agentId: string;
  status: StepStatus;
  rerun?: boolean;
  rerunCount?: number;
  logs: string[];
  artifacts: Artifact[];
  summary?: string;
};

export type RunRecord = {
  run: Run;
  pipelineSnapshot: Pipeline;
  steps: StepRun[];
};

export type RunStreamEvent =
  | {
      type: "stepStatus";
      stepId: string;
      status: StepStatus;
    }
  | {
      type: "logLine";
      stepId: string;
      line: string;
    }
  | {
      type: "artifactCreated";
      stepId: string;
      artifact: Artifact;
    }
  | {
      type: "runStatus";
      status: RunStatus;
    };
