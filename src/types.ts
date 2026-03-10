export type RunnerType = "cli" | "docker" | "http" | "llm";

export type RunStatus = "queued" | "running" | "success" | "failed" | "canceled";
export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped" | "canceled";

export interface PipelineGraphNode {
  id: string;
  agentId: string;
  goal?: string;
  settings?: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface PipelineGraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface PipelineGraph {
  nodes: PipelineGraphNode[];
  edges: PipelineGraphEdge[];
}

export type NodeMessageRole = "user" | "agent" | "system";
export type NodeMessagePhase = "pre_run" | "run";

export interface AgentInputSpec {
  type: string;
  required?: boolean;
  multi?: boolean;
}

export interface AgentOutputSpec {
  type: string;
}

export interface AgentPermissions {
  filesystem?: boolean;
  network?: boolean;
  process?: boolean;
}

export interface AgentManifest {
  id: string;
  version: string;
  title: string;
  runner: RunnerType;
  inputs: AgentInputSpec[];
  outputs: AgentOutputSpec[];
  configSchema?: Record<string, unknown>;
  permissions?: AgentPermissions;
}

export interface PipelineRecord {
  id: string;
  name: string;
  graph_json: string;
  created_at: string;
  updated_at: string;
}

export interface RunRecord {
  id: string;
  pipeline_id: string;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  error_summary: string | null;
}

export interface StepRunRecord {
  id: string;
  run_id: string;
  node_id: string;
  agent_id: string;
  status: StepStatus;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  error_summary: string | null;
}

export interface ArtifactRecord {
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
}

export interface SecretRecord {
  id: string;
  provider: string;
  label: string;
  created_at: string;
  keychain_ref: string;
}

export interface PlanIssue {
  severity: "error" | "warning";
  code: string;
  nodeId: string;
  inputType: string;
  message: string;
}

export interface HandoffPlanTarget {
  nodeId: string;
  context: string;
  launchHints: string[];
}

export interface NodeExecutionPlan {
  nodeId: string;
  agentId: string;
  goal: string;
  goalAddendum?: string;
  handoffContext?: string;
  receivesFrom: string[];
  handoffTo: HandoffPlanTarget[];
  notes: string[];
}

export interface RunPlanData {
  runId: string;
  pipelineId: string;
  createdAt: string;
  nodes: NodeExecutionPlan[];
  issues: PlanIssue[];
  isExecutable: boolean;
}

export interface RunPlanRecord {
  run_id: string;
  pipeline_id: string;
  plan_json: string;
  created_at: string;
}

export interface NodeMessageRecord {
  id: string;
  run_id: string;
  node_id: string;
  role: NodeMessageRole;
  phase: NodeMessagePhase;
  content: string;
  created_at: string;
  meta_json: string | null;
}

export interface HandoffPacket {
  schemaVersion: number;
  runId: string;
  stepRunId: string;
  fromNodeId: string;
  fromAgentId: string;
  goal: string;
  summary: string;
  context: string;
  changedFiles: string[];
  urls: string[];
  launchHints: string[];
  handoffTo: HandoffPlanTarget[];
  generatedAt: string;
}

export interface ResolvedHandoff {
  fromNodeId: string;
  artifact: ArtifactRecord;
  packet: HandoffPacket | null;
}

export interface ResolvedInputs {
  inputsByType: Record<string, ArtifactRecord[]>;
  predecessorArtifacts: Array<ArtifactRecord & { node_id: string }>;
  handoffs: ResolvedHandoff[];
}

export interface StepExecutionContext {
  runId: string;
  stepRunId: string;
  nodeId: string;
  workspacePath: string;
  stepDir: string;
  stepLogPath: string;
  goal: string;
  settings: Record<string, unknown>;
  plannedNode: NodeExecutionPlan;
  resolvedInputs: ResolvedInputs;
  env: NodeJS.ProcessEnv;
  reportMode?: boolean;
  reportContext?: {
    stepStatus: StepStatus;
    stepError?: string | null;
    artifactTitles?: string[];
    logTail?: string[];
    followupPrompt?: string;
    chatHistory?: Array<{
      role: NodeMessageRole;
      content: string;
      createdAt: string;
    }>;
  };
}

export interface ProducedArtifact {
  type: string;
  title: string;
  filePath: string;
  mime: string;
  meta?: Record<string, unknown>;
}

export interface RunnerPreparedCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}
