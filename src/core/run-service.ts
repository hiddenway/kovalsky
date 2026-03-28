import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type pino from "pino";
import { GraphExecutor } from "./graph-executor";
import { DatabaseService } from "../db";
import type {
  ArtifactRecord,
  NodeExecutionPlan,
  NodeMessagePhase,
  NodeMessageRecord,
  NodeMessageRole,
  PipelineGraph,
  PipelineGraphNode,
  ResolvedInputs,
  RunPlanData,
  StepRunRecord,
  StepStatus,
} from "../types";
import { ProviderService } from "../providers/provider-service";
import type { EventBus } from "./event-bus";
import { ArtifactStore } from "../artifacts/store";
import { nowIso } from "../utils/time";
import { AgentHost } from "./agent-host";
import { normalizeUrlCandidate } from "../utils/url";
import { readCodexAuthState } from "../utils/codex-auth";
import { SettingsService } from "./settings-service";
import type { OpenClawProviderMode } from "./settings-service";
import { resolveWorkspacePath } from "../utils/workspace-path";
import type { LoopContinuationRequest } from "./graph-executor";

interface ActiveRunControl {
  canceled: boolean;
  waitingLoopContinuation: boolean;
  loopContinuationTimer: ReturnType<typeof setTimeout> | null;
}

export interface StartRunOverrides {
  workspacePath: string;
  maxParallelSteps?: number;
  stopOnFailure?: boolean;
  timeoutMs?: number;
  credentialId?: string;
  clearNodeChatContext?: boolean;
}

type FollowupRerunDecision = "rerun" | "no_rerun" | "unknown";
type NodeChatContextMode = "off" | "light" | "strict";
type NodeFollowupRerunLaunch = "started" | "already_running";
type OpenClawTokenSource = "none" | "openclaw_credential" | "codex_oauth";

interface FollowupReplyResult {
  reply: string;
  decision: FollowupRerunDecision;
}

const DEFAULT_OPENCLAW_GATEWAY_PORT = 47289;
const OPENCLAW_GATEWAY_ENSURE_INTERVAL_MS = 15_000;
const OPENCLAW_GATEWAY_COMMAND_TIMEOUT_MS = 20_000;

export class RunService {
  private readonly controls = new Map<string, ActiveRunControl>();
  private readonly activeNodeFollowupReruns = new Set<string>();
  private readonly openClawGatewayEnsureLocks = new Map<string, Promise<void>>();
  private readonly openClawGatewayLastCheckedAt = new Map<string, number>();
  private readonly db: DatabaseService;
  private readonly graphExecutor: GraphExecutor;
  private readonly agentHost: AgentHost;
  private readonly providerService: ProviderService;
  private readonly settingsService: SettingsService;
  private readonly artifactStore: ArtifactStore;
  private readonly eventBus: EventBus;
  private readonly logger: pino.Logger;

  constructor(
    db: DatabaseService,
    graphExecutor: GraphExecutor,
    agentHost: AgentHost,
    providerService: ProviderService,
    settingsOrArtifactStore: SettingsService | ArtifactStore,
    artifactStoreOrEventBus: ArtifactStore | EventBus,
    eventBusOrLogger: EventBus | pino.Logger,
    loggerMaybe?: pino.Logger,
  ) {
    this.db = db;
    this.graphExecutor = graphExecutor;
    this.agentHost = agentHost;
    this.providerService = providerService;

    // Backward compatibility for old constructor call-sites:
    // (db, graphExecutor, agentHost, providerService, artifactStore, eventBus, logger)
    if (settingsOrArtifactStore instanceof ArtifactStore) {
      this.settingsService = new SettingsService(this.resolveDefaultAppDataDir());
      this.artifactStore = settingsOrArtifactStore;
      this.eventBus = artifactStoreOrEventBus as EventBus;
      this.logger = eventBusOrLogger as pino.Logger;
      return;
    }

    this.settingsService = settingsOrArtifactStore;
    this.artifactStore = artifactStoreOrEventBus as ArtifactStore;
    this.eventBus = eventBusOrLogger as EventBus;
    this.logger = loggerMaybe as pino.Logger;
  }

  async startRun(pipelineId: string, graph: PipelineGraph, overrides: StartRunOverrides): Promise<{ runId: string }> {
    const run = this.db.createRun(pipelineId);
    const control: ActiveRunControl = {
      canceled: false,
      waitingLoopContinuation: false,
      loopContinuationTimer: null,
    };
    this.controls.set(run.id, control);

    const workspacePath = this.resolveWorkspacePath(overrides.workspacePath);
    if (!workspacePath) {
      throw new Error(`Workspace path not found: ${overrides.workspacePath}`);
    }

    const workspaceReportPath = this.prepareWorkspaceReportLink(run.id, workspacePath);

    if (overrides.clearNodeChatContext === true) {
      this.db.deleteNodeMessagesByPipeline(pipelineId);
    }

    const env = await this.buildAgentEnv(overrides.credentialId);
    const executionGraph = this.applyPipelineChatContextToGraph(graph, pipelineId);

    for (const node of executionGraph.nodes) {
      if ((node.goal ?? "").trim()) {
        this.createNodeMessage({
          runId: run.id,
          nodeId: node.id,
          role: "user",
          phase: "pre_run",
          content: node.goal ?? "",
          meta: { kind: "goal" },
        });
      }
      this.createNodeMessage({
        runId: run.id,
        nodeId: node.id,
        role: "system",
        phase: "pre_run",
        content: `Workspace: ${workspacePath}\nWorkspace report: ${workspaceReportPath}`,
        meta: { workspacePath, workspaceReportPath },
      });
    }

    const plan = this.buildDeterministicPlan(run.id, pipelineId, executionGraph);
    this.db.upsertRunPlan(run.id, pipelineId, JSON.stringify(plan));

    for (const nodePlan of plan.nodes) {
      this.createNodeMessage({
        runId: run.id,
        nodeId: nodePlan.nodeId,
        role: "system",
        phase: "pre_run",
        content: this.buildPlanSummary(nodePlan),
      });
    }

    this.eventBus.emit({
      runId: run.id,
      type: "plan_finalized",
      at: new Date().toISOString(),
      payload: {
        isExecutable: plan.isExecutable,
        issues: plan.issues,
      },
    });

    void this.graphExecutor
      .executeRun(
        run.id,
        executionGraph,
        plan,
        {
          workspacePath,
          maxParallelSteps: overrides.maxParallelSteps,
          stopOnFailure: overrides.stopOnFailure,
          timeoutMs: overrides.timeoutMs,
          env,
        },
        {
          isCanceled: () => control.canceled,
        },
      )
      .then((result) => {
        if (result.status !== "success" || !result.loopContinuation) {
          return;
        }
        const timer = this.scheduleLoopContinuation({
          sourceRunId: run.id,
          control,
          pipelineId,
          workspacePath,
          continuation: result.loopContinuation,
          previousOverrides: overrides,
        });
        if (timer) {
          control.waitingLoopContinuation = true;
          control.loopContinuationTimer = timer;
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Run failed";
        this.logger.error({ err: error, runId: run.id }, "run execution failed");
        this.db.updateRunStatus(run.id, "failed", message);
      })
      .finally(() => {
        if (control.waitingLoopContinuation) {
          return;
        }
        this.controls.delete(run.id);
      });

    return { runId: run.id };
  }

  private scheduleLoopContinuation(input: {
    sourceRunId: string;
    control: ActiveRunControl;
    pipelineId: string;
    workspacePath: string;
    continuation: LoopContinuationRequest;
    previousOverrides: StartRunOverrides;
  }): ReturnType<typeof setTimeout> | null {
    const delayMs = Math.max(0, input.continuation.delaySeconds * 1000);
    const runNextCycle = async (): Promise<void> => {
      const pipeline = this.db.getPipeline(input.pipelineId);
      if (!pipeline) {
        return;
      }

      let graph: PipelineGraph;
      try {
        graph = JSON.parse(pipeline.graph_json) as PipelineGraph;
      } catch {
        return;
      }

      const nextGraph = this.buildLoopContinuationGraph(graph, input.continuation);
      if (nextGraph.nodes.length === 0) {
        this.logger.warn(
          {
            pipelineId: input.pipelineId,
            continuation: input.continuation,
          },
          "loop continuation was skipped because no reachable restart graph was produced",
        );
        return;
      }

      try {
        const started = await this.startRun(input.pipelineId, nextGraph, {
          workspacePath: input.workspacePath,
          maxParallelSteps: input.previousOverrides.maxParallelSteps,
          stopOnFailure: input.previousOverrides.stopOnFailure,
          timeoutMs: input.previousOverrides.timeoutMs,
          credentialId: input.previousOverrides.credentialId,
          clearNodeChatContext: !input.continuation.carryContext,
        });
        this.logger.info(
          {
            pipelineId: input.pipelineId,
            runId: started.runId,
            delaySeconds: input.continuation.delaySeconds,
            carryContext: input.continuation.carryContext,
            restartTargets: input.continuation.targetNodeIds,
          },
          "loop continuation run started",
        );
      } catch (error) {
        this.logger.error(
          {
            err: error,
            pipelineId: input.pipelineId,
            continuation: input.continuation,
          },
          "failed to start loop continuation run",
        );
      }
    };

    if (delayMs === 0) {
      void runNextCycle().finally(() => {
        this.controls.delete(input.sourceRunId);
      });
      return null;
    }

    return setTimeout(() => {
      input.control.loopContinuationTimer = null;
      input.control.waitingLoopContinuation = false;
      if (input.control.canceled) {
        this.controls.delete(input.sourceRunId);
        return;
      }
      void runNextCycle().finally(() => {
        this.controls.delete(input.sourceRunId);
      });
    }, delayMs);
  }

  private buildLoopContinuationGraph(graph: PipelineGraph, continuation: LoopContinuationRequest): PipelineGraph {
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const loopNodeIds = new Set(
      graph.nodes
        .filter((node) => node.agentId === "loop")
        .map((node) => node.id),
    );
    const restartTargets = [...new Set(continuation.targetNodeIds)].filter((nodeId) => nodeById.has(nodeId));
    if (restartTargets.length === 0) {
      return { nodes: [], edges: [] };
    }

    const outgoing = new Map<string, string[]>();
    for (const node of graph.nodes) {
      outgoing.set(node.id, []);
    }
    for (const edge of graph.edges) {
      if (loopNodeIds.has(edge.source)) {
        continue;
      }
      outgoing.get(edge.source)?.push(edge.target);
    }

    const reachable = new Set<string>();
    const stack = [...restartTargets];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (reachable.has(current) || !nodeById.has(current)) {
        continue;
      }
      reachable.add(current);
      for (const next of outgoing.get(current) ?? []) {
        if (!reachable.has(next)) {
          stack.push(next);
        }
      }
    }

    const restartTargetSet = new Set(restartTargets);
    return {
      nodes: graph.nodes.filter((node) => reachable.has(node.id)),
      edges: graph.edges.filter((edge) =>
        reachable.has(edge.source)
        && reachable.has(edge.target)
        && (
          // Keep loopback edges so the next cycle can schedule continuation again.
          loopNodeIds.has(edge.source)
          // Restart targets are cycle entry points and must start without non-loop prerequisites.
          || !restartTargetSet.has(edge.target)
        )
      ),
    };
  }

  async buildAutomationEnv(openaiCredentialId?: string): Promise<NodeJS.ProcessEnv> {
    return this.buildAgentEnv(openaiCredentialId);
  }

  private resolveWorkspacePath(rawPath: string): string | null {
    return resolveWorkspacePath(rawPath);
  }

  async cancelRun(runId: string): Promise<boolean> {
    const control = this.controls.get(runId);
    if (control) {
      control.canceled = true;
      if (control.loopContinuationTimer) {
        clearTimeout(control.loopContinuationTimer);
        control.loopContinuationTimer = null;
      }
      control.waitingLoopContinuation = false;
      void this.graphExecutor.cancelRun(runId).catch((error) => {
        this.logger.warn({ err: error, runId }, "failed to cancel active run processes");
      });
      void this.markRunCanceled(runId, "Run canceled by user");
      this.controls.delete(runId);
      return true;
    }

    const run = this.db.getRun(runId);
    if (!run) {
      return false;
    }

    if (run.status !== "queued" && run.status !== "running" && !this.hasInProgressStepRuns(runId)) {
      return false;
    }

    void this.markRunCanceled(runId, "Run canceled by user");
    return true;
  }

  getRunSnapshot(runId: string): {
    run: ReturnType<DatabaseService["getRun"]>;
    stepRuns: ReturnType<DatabaseService["getStepRunsByRun"]>;
    artifacts: ReturnType<DatabaseService["getArtifactsByRun"]>;
    plan: RunPlanData | null;
    loopWaiting: boolean;
  } {
    const control = this.controls.get(runId);
    return {
      run: this.db.getRun(runId),
      stepRuns: this.db.getStepRunsByRun(runId),
      artifacts: this.db.getArtifactsByRun(runId),
      plan: this.getRunPlan(runId),
      loopWaiting: control?.waitingLoopContinuation === true,
    };
  }

  getRunPlan(runId: string): RunPlanData | null {
    const record = this.db.getRunPlan(runId);
    if (!record) {
      return null;
    }
    return JSON.parse(record.plan_json) as RunPlanData;
  }

  getNodeChat(runId: string, nodeId: string) {
    return this.getPipelineNodeMessages(runId, nodeId);
  }

  appendNodeChat(input: {
    runId: string;
    nodeId: string;
    content: string;
    role?: NodeMessageRole;
    phase?: NodeMessagePhase;
    meta?: Record<string, unknown>;
  }) {
    return this.createNodeMessage({
      runId: input.runId,
      nodeId: input.nodeId,
      role: input.role ?? "user",
      phase: input.phase ?? "pre_run",
      content: input.content,
      meta: input.meta,
    });
  }

  async replyNodeChat(input: {
    runId: string;
    nodeId: string;
    content: string;
    rerunMode?: "node" | "pipeline";
  }) {
    const prompt = input.content.trim();
    if (!prompt) {
      throw new Error("Chat content is empty");
    }

    const userMessage = this.createNodeMessage({
      runId: input.runId,
      nodeId: input.nodeId,
      role: "user",
      phase: "run",
      content: prompt,
      meta: { source: "chat_followup" },
    });

    const followup = await this.generateNodeFollowupReply({
      runId: input.runId,
      nodeId: input.nodeId,
      prompt,
    });
    const shouldLaunchFollowup = followup.decision === "rerun";
    const requestedRerunMode = input.rerunMode === "pipeline" ? "pipeline" : "node";
    const rerunMode = this.isImmediateStopServerRequest(prompt) ? "node" : requestedRerunMode;
    const awaitingUserInput = this.isAwaitingUserInputReply({
      reply: followup.reply,
      decision: followup.decision,
    });
    let nodeRerunLaunch: NodeFollowupRerunLaunch | null = null;
    let startedRunId: string | null = null;
    let pipelineRerunError: string | null = null;

    if (shouldLaunchFollowup) {
      if (rerunMode === "pipeline") {
        const followupRun = await this.executeFollowupPipelineRun({
          runId: input.runId,
          nodeId: input.nodeId,
          prompt,
          announce: false,
        });
        startedRunId = followupRun.startedRunId ?? null;
        pipelineRerunError = followupRun.error ?? null;
      } else {
        nodeRerunLaunch = this.startFollowupNodeRunIfIdle({
          runId: input.runId,
          nodeId: input.nodeId,
          prompt,
        });
      }
    }

    const agentMessage = this.createNodeMessage({
      runId: input.runId,
      nodeId: input.nodeId,
      role: "agent",
      phase: "run",
      content: followup.reply,
      meta: {
        source: "chat_followup_report",
        rerunDecision: followup.decision,
        rerunMode,
        awaitingUserInput: awaitingUserInput || undefined,
        startedRunId: startedRunId ?? undefined,
        rerunError: pipelineRerunError ?? undefined,
        nodeRerunLaunch: nodeRerunLaunch ?? undefined,
      },
    });

    if (shouldLaunchFollowup) {
      if (rerunMode === "pipeline") {
        this.createNodeMessage({
          runId: input.runId,
          nodeId: input.nodeId,
          role: "system",
          phase: "run",
          content: startedRunId
            ? `Started a new workflow rerun: ${startedRunId}`
            : `Failed to start a new workflow rerun: ${pipelineRerunError ?? "unknown error"}`,
          meta: {
            source: "chat_followup_rerun_status",
            rerunMode,
            startedRunId: startedRunId ?? undefined,
            rerunError: pipelineRerunError ?? undefined,
          },
        });
      } else {
        const content = nodeRerunLaunch === "already_running"
          ? "A rerun of this node is already in progress. Please wait for it to finish."
          : "Starting a rerun of this node based on your message.";
        this.createNodeMessage({
          runId: input.runId,
          nodeId: input.nodeId,
          role: "system",
          phase: "run",
          content,
          meta: {
            source: "chat_followup_rerun_status",
            rerunMode,
            nodeRerunLaunch: nodeRerunLaunch ?? undefined,
          },
        });
      }
    }

    return { userMessage, agentMessage };
  }

  private startFollowupNodeRunIfIdle(input: {
    runId: string;
    nodeId: string;
    prompt: string;
  }): NodeFollowupRerunLaunch {
    const key = this.buildNodeFollowupRerunKey(input.runId, input.nodeId);
    if (this.activeNodeFollowupReruns.has(key) || this.hasNodeFollowupRerunInProgress(input.runId, input.nodeId)) {
      return "already_running";
    }

    this.activeNodeFollowupReruns.add(key);
    void this.executeFollowupNodeRun(input).finally(() => {
      this.activeNodeFollowupReruns.delete(key);
    });
    return "started";
  }

  private buildNodeFollowupRerunKey(runId: string, nodeId: string): string {
    return `${runId}:${nodeId}`;
  }

  private hasNodeFollowupRerunInProgress(runId: string, nodeId: string): boolean {
    return this.db
      .getStepRunsByRun(runId)
      .some((step) => step.node_id === nodeId && (step.status === "pending" || step.status === "running"));
  }

  private isRunCanceled(runId: string): boolean {
    return this.db.getRun(runId)?.status === "canceled";
  }

  private async executeFollowupNodeRun(input: {
    runId: string;
    nodeId: string;
    prompt: string;
  }): Promise<void> {
    const run = this.db.getRun(input.runId);
    if (!run) {
      this.createNodeMessage({
        runId: input.runId,
        nodeId: input.nodeId,
        role: "system",
        phase: "run",
        content: "Rerun canceled: run not found.",
      });
      return;
    }

    if (this.controls.has(input.runId)) {
      this.createNodeMessage({
        runId: input.runId,
        nodeId: input.nodeId,
        role: "system",
        phase: "run",
        content: "Run is already in progress. Wait until the current run finishes.",
      });
      return;
    }

    const pipeline = this.db.getPipeline(run.pipeline_id);
    if (!pipeline) {
      this.createNodeMessage({
        runId: input.runId,
        nodeId: input.nodeId,
        role: "system",
        phase: "run",
        content: "Rerun canceled: workflow not found.",
      });
      return;
    }

    const graph = JSON.parse(pipeline.graph_json) as PipelineGraph;
    const node = graph.nodes.find((item) => item.id === input.nodeId);
    if (!node) {
      this.createNodeMessage({
        runId: input.runId,
        nodeId: input.nodeId,
        role: "system",
        phase: "run",
        content: "Rerun canceled: node not found in the graph.",
      });
      return;
    }

    const workspacePath = this.resolveWorkspacePathFromNodeChat(input.runId, input.nodeId) ?? process.cwd();
    const stepRun = this.db.createStepRun(input.runId, input.nodeId, node.agentId);
    const nodePlan = this.resolveNodePlan(input.runId, node);
    const resolvedInputs: ResolvedInputs = {
      inputsByType: {},
      predecessorArtifacts: [],
      handoffs: [],
    };

    this.db.updateRunStatus(input.runId, "running", null);
    this.eventBus.emit({
      runId: input.runId,
      type: "run_status",
      at: new Date().toISOString(),
      payload: { status: "running" },
    });

    this.eventBus.emit({
      runId: input.runId,
      type: "step_status",
      at: new Date().toISOString(),
      payload: {
        nodeId: input.nodeId,
        stepRunId: stepRun.id,
        status: "pending",
      },
    });

    this.db.updateStepRunStatus(stepRun.id, "running", null, null);
    this.eventBus.emit({
      runId: input.runId,
      type: "step_status",
      at: new Date().toISOString(),
      payload: {
        nodeId: input.nodeId,
        stepRunId: stepRun.id,
        status: "running",
      },
    });

    this.artifactStore.ensureStepDirs(input.runId, stepRun.id);
    const stepDir = this.artifactStore.getStepDir(input.runId, stepRun.id);
    const stepLogPath = this.artifactStore.getStepLogPath(input.runId, stepRun.id);
    const nodeMessages = this.getPipelineNodeMessages(input.runId, input.nodeId);
    const chatContextMode = this.resolveNodeChatContextMode(node.settings);
    const recentChatContext = chatContextMode === "off"
      ? ""
      : this.buildPipelineChatContextSnippet(nodeMessages, chatContextMode);
    let effectiveGoal = this.buildNodeGoalWithChatContext(
      (node.goal ?? "").trim(),
      recentChatContext,
      input.prompt,
      chatContextMode,
    );
    if (this.isImmediateStopServerRequest(input.prompt)) {
      effectiveGoal = this.buildStopServerOnlyGoal(effectiveGoal, input.prompt);
    }

    try {
      const result = await this.agentHost.runStep({
        agentId: node.agentId,
        context: {
          runId: input.runId,
          stepRunId: stepRun.id,
          nodeId: node.id,
          workspacePath,
          stepDir,
          stepLogPath,
          goal: effectiveGoal,
          settings: node.settings ?? {},
          plannedNode: nodePlan,
          resolvedInputs,
          env: await this.buildAgentEnv(),
        },
      });

      const artifactTitles = result.artifactIds
        .map((artifactId) => this.db.getArtifact(artifactId))
        .filter((artifact): artifact is ArtifactRecord => Boolean(artifact))
        .map((artifact) => `${artifact.title} (${artifact.type})`);

      if (this.isRunCanceled(input.runId)) {
        this.db.updateStepRunStatus(stepRun.id, "canceled", null, "Run canceled by user");
        this.eventBus.emit({
          runId: input.runId,
          type: "step_status",
          at: new Date().toISOString(),
          payload: {
            nodeId: input.nodeId,
            stepRunId: stepRun.id,
            status: "canceled",
          },
        });
        this.eventBus.emit({
          runId: input.runId,
          type: "run_status",
          at: new Date().toISOString(),
          payload: {
            status: "canceled",
            errorSummary: "Run canceled by user",
          },
        });
        return;
      }

      if (result.exitCode !== 0) {
        const error = `Agent exited with code ${result.exitCode}`;
        this.db.updateStepRunStatus(stepRun.id, "failed", result.exitCode, error);
        this.db.updateRunStatus(input.runId, "failed", error);
        this.eventBus.emit({
          runId: input.runId,
          type: "step_status",
          at: new Date().toISOString(),
          payload: {
            nodeId: input.nodeId,
            stepRunId: stepRun.id,
            status: "failed",
            error,
          },
        });
        this.eventBus.emit({
          runId: input.runId,
          type: "run_status",
          at: new Date().toISOString(),
          payload: {
            status: "failed",
            errorSummary: error,
          },
        });
        this.createNodeMessage({
          runId: input.runId,
          nodeId: input.nodeId,
          role: "agent",
          phase: "run",
          content: `Rerun failed: ${error}`,
        });
        return;
      }

      this.db.updateStepRunStatus(stepRun.id, "success", 0, null);
      const reconciledRun = this.reconcileRunStatusFromLatestSteps(input.runId);
      this.db.updateRunStatus(input.runId, reconciledRun.status, reconciledRun.errorSummary);
      this.eventBus.emit({
        runId: input.runId,
        type: "step_status",
        at: new Date().toISOString(),
        payload: {
          nodeId: input.nodeId,
          stepRunId: stepRun.id,
          status: "success",
        },
      });
      this.eventBus.emit({
        runId: input.runId,
        type: "run_status",
        at: new Date().toISOString(),
        payload: {
          status: reconciledRun.status,
          errorSummary: reconciledRun.errorSummary,
        },
      });
      this.createNodeMessage({
        runId: input.runId,
        nodeId: input.nodeId,
        role: "agent",
        phase: "run",
        content: "Rerun completed successfully.",
      });

      void this.emitPostStepReportForFollowup({
        runId: input.runId,
        node,
        stepRunId: stepRun.id,
        nodePlan,
        workspacePath,
        stepDir,
        stepLogPath,
        resolvedInputs,
        env: await this.buildAgentEnv(),
        status: "success",
        errorSummary: null,
        artifactTitles,
        followupPrompt: input.prompt,
      });
    } catch (error) {
      if (this.isRunCanceled(input.runId)) {
        this.db.updateStepRunStatus(stepRun.id, "canceled", null, "Run canceled by user");
        this.eventBus.emit({
          runId: input.runId,
          type: "step_status",
          at: new Date().toISOString(),
          payload: {
            nodeId: input.nodeId,
            stepRunId: stepRun.id,
            status: "canceled",
          },
        });
        this.eventBus.emit({
          runId: input.runId,
          type: "run_status",
          at: new Date().toISOString(),
          payload: {
            status: "canceled",
            errorSummary: "Run canceled by user",
          },
        });
        return;
      }

      const message = error instanceof Error ? error.message : "Step execution failed";
      this.db.updateStepRunStatus(stepRun.id, "failed", 1, message);
      this.db.updateRunStatus(input.runId, "failed", message);
      this.eventBus.emit({
        runId: input.runId,
        type: "step_status",
        at: new Date().toISOString(),
        payload: {
          nodeId: input.nodeId,
          stepRunId: stepRun.id,
          status: "failed",
          error: message,
        },
      });
      this.eventBus.emit({
        runId: input.runId,
        type: "run_status",
        at: new Date().toISOString(),
        payload: {
          status: "failed",
          errorSummary: message,
        },
      });
      this.createNodeMessage({
        runId: input.runId,
        nodeId: input.nodeId,
        role: "agent",
        phase: "run",
        content: `Rerun failed: ${message}`,
      });
    }
  }

  private async executeFollowupPipelineRun(input: {
    runId: string;
    nodeId: string;
    prompt: string;
    announce?: boolean;
  }): Promise<{ startedRunId?: string; error?: string }> {
    const shouldAnnounce = input.announce !== false;
    const run = this.db.getRun(input.runId);
    if (!run) {
      if (shouldAnnounce) {
        this.createNodeMessage({
          runId: input.runId,
          nodeId: input.nodeId,
          role: "system",
          phase: "run",
          content: "Workflow rerun canceled: run not found.",
        });
      }
      return { error: "run not found" };
    }

    const pipeline = this.db.getPipeline(run.pipeline_id);
    if (!pipeline) {
      if (shouldAnnounce) {
        this.createNodeMessage({
          runId: input.runId,
          nodeId: input.nodeId,
          role: "system",
          phase: "run",
          content: "Workflow rerun canceled: workflow not found.",
        });
      }
      return { error: "workflow not found" };
    }

    const nodeMessages = this.getPipelineNodeMessages(input.runId, input.nodeId);
    const workspacePath = this.resolveWorkspacePathFromNodeChat(input.runId, input.nodeId, nodeMessages) ?? process.cwd();
    const graph = JSON.parse(pipeline.graph_json) as PipelineGraph;
    const followupGraph = this.applyPipelineFollowupToGraph(graph, input.nodeId, input.prompt, nodeMessages);

    try {
      const started = await this.startRun(pipeline.id, followupGraph, {
        workspacePath,
      });
      if (shouldAnnounce) {
        this.createNodeMessage({
          runId: input.runId,
          nodeId: input.nodeId,
          role: "agent",
          phase: "run",
          content: `Started a new full workflow rerun: ${started.runId}`,
          meta: {
            source: "chat_followup_rerun",
            rerunMode: "pipeline",
            startedRunId: started.runId,
          },
        });
      }
      return { startedRunId: started.runId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start workflow rerun";
      if (shouldAnnounce) {
        this.createNodeMessage({
          runId: input.runId,
          nodeId: input.nodeId,
          role: "agent",
          phase: "run",
          content: `Failed to start full workflow rerun: ${message}`,
          meta: {
            source: "chat_followup_rerun",
            rerunMode: "pipeline",
          },
        });
      }
      return { error: message };
    }
  }

  private async emitPostStepReportForFollowup(input: {
    runId: string;
    node: PipelineGraphNode;
    stepRunId: string;
    nodePlan: NodeExecutionPlan;
    workspacePath: string;
    stepDir: string;
    stepLogPath: string;
    resolvedInputs: ResolvedInputs;
    env: NodeJS.ProcessEnv;
    status: StepStatus;
    errorSummary: string | null;
    artifactTitles: string[];
    followupPrompt: string;
  }): Promise<void> {
    try {
      const report = await this.agentHost.runNodeReport({
        agentId: input.node.agentId,
        context: {
          runId: input.runId,
          stepRunId: input.stepRunId,
          nodeId: input.node.id,
          workspacePath: input.workspacePath,
          stepDir: input.stepDir,
          stepLogPath: input.stepLogPath,
          goal: input.node.goal ?? "",
          settings: input.node.settings ?? {},
          plannedNode: input.nodePlan,
          resolvedInputs: input.resolvedInputs,
          env: input.env,
          reportMode: true,
          reportContext: {
            reportKind: "post_step",
            stepStatus: input.status,
            stepError: input.errorSummary ?? undefined,
            artifactTitles: input.artifactTitles,
            logTail: this.readStepLogTail(input.stepLogPath, 20),
            followupPrompt: input.followupPrompt,
            chatHistory: this.buildAssistantChatHistory(this.getPipelineNodeMessages(input.runId, input.node.id)),
          },
        },
      });

      const cleaned = this.cleanReportReply(report);
      if (!cleaned) {
        return;
      }

      this.createNodeMessage({
        runId: input.runId,
        nodeId: input.node.id,
        role: "agent",
        phase: "run",
        content: `Post-step report:\n${cleaned}`,
      });
    } catch (error) {
      this.logger.warn(
        { err: error, runId: input.runId, nodeId: input.node.id, stepRunId: input.stepRunId },
        "post-step report generation failed for chat followup execution",
      );
    }
  }

  private createNodeMessage(input: {
    runId: string;
    nodeId: string;
    role: NodeMessageRole;
    phase: NodeMessagePhase;
    content: string;
    meta?: Record<string, unknown>;
  }) {
    const message = this.db.createNodeMessage(input);
    this.eventBus.emit({
      runId: input.runId,
      type: "chat_message",
      at: new Date().toISOString(),
      payload: {
        nodeId: input.nodeId,
        message,
      },
    });
    return message;
  }

  private async generateNodeFollowupReply(input: {
    runId: string;
    nodeId: string;
    prompt: string;
  }): Promise<FollowupReplyResult> {
    const run = this.db.getRun(input.runId);
    if (!run) {
      return {
        reply: "Run not found.",
        decision: "no_rerun",
      };
    }

    const pipeline = this.db.getPipeline(run.pipeline_id);
    if (!pipeline) {
      return {
        reply: "Workflow not found for this run.",
        decision: "no_rerun",
      };
    }

    const graph = JSON.parse(pipeline.graph_json) as PipelineGraph;
    const node = graph.nodes.find((item) => item.id === input.nodeId);
    if (!node) {
      return {
        reply: "Node not found in workflow graph.",
        decision: "no_rerun",
      };
    }

    const stepRun = this.db.getStepRunByNode(input.runId, input.nodeId);
    if (!stepRun) {
      return {
        reply: this.buildNoStepReply(input.prompt),
        decision: "no_rerun",
      };
    }

    const nodeMessages = this.getPipelineNodeMessages(input.runId, input.nodeId);
    const workspacePath = this.resolveWorkspacePathFromNodeChat(input.runId, input.nodeId, nodeMessages) ?? process.cwd();
    this.artifactStore.ensureStepDirs(input.runId, stepRun.id);
    const stepDir = this.artifactStore.getStepDir(input.runId, stepRun.id);
    const stepLogPath = this.artifactStore.getStepLogPath(input.runId, stepRun.id);
    const nodePlan = this.resolveNodePlan(input.runId, node);
    const stepArtifacts = this.db
      .getArtifactsByRun(input.runId)
      .filter((artifact) => artifact.produced_by_step_run_id === stepRun.id)
      .filter((artifact) => artifact.type !== "BlackboxReport");
    const artifactTitles = stepArtifacts.map((artifact) => `${artifact.title} (${artifact.type})`);

    const resolvedInputs: ResolvedInputs = {
      inputsByType: {},
      predecessorArtifacts: [],
      handoffs: [],
    };

    try {
      const report = await this.agentHost.runNodeReport({
        agentId: node.agentId,
        context: {
          runId: input.runId,
          stepRunId: stepRun.id,
          nodeId: input.nodeId,
          workspacePath,
          stepDir,
          stepLogPath,
          goal: node.goal ?? "",
          settings: node.settings ?? {},
          plannedNode: nodePlan,
          resolvedInputs,
          env: await this.buildAgentEnv(),
          reportMode: true,
          reportContext: {
            reportKind: "chat_followup",
            stepStatus: stepRun.status,
            stepError: stepRun.error_summary ?? undefined,
            artifactTitles,
            logTail: this.readStepLogTail(stepLogPath, 24),
            followupPrompt: input.prompt,
            chatHistory: this.buildAssistantChatHistory(nodeMessages),
          },
        },
      });

      let decision = this.extractModelRerunDecision(report);
      let cleaned = this.cleanReportReply(report);
      if (node.agentId === "openclaw") {
        const actionRequested = this.isImmediateExecutionRequest(input.prompt);
        const onboardingReply = this.isLikelyOnboardingReply(cleaned);
        const capabilityDenialReply = this.isLikelyCapabilityDenialReply(cleaned);
        if (actionRequested && (decision !== "rerun" || capabilityDenialReply)) {
          decision = "rerun";
          if (!cleaned || onboardingReply || capabilityDenialReply) {
            cleaned = this.isLikelyRussianText(input.prompt)
              ? "Принял. Запускаю выполнение запроса сейчас."
              : "Understood. Starting execution now.";
          }
        } else if (onboardingReply) {
          cleaned = "";
        }
      }
      if (cleaned) {
        return this.applyImmediateFollowupPolicy(input.prompt, {
          reply: cleaned,
          decision,
        });
      }
      return this.applyImmediateFollowupPolicy(input.prompt, {
        reply: this.buildFallbackFollowupReply({
          prompt: input.prompt,
          status: stepRun.status,
          stepError: stepRun.error_summary,
          artifactTitles,
          urls: this.extractUrls(stepArtifacts),
        }),
        decision,
      });
    } catch (error) {
      this.logger.warn(
        { err: error, runId: input.runId, nodeId: input.nodeId, stepRunId: stepRun.id },
        "followup chat report generation failed",
      );
    }

    return this.applyImmediateFollowupPolicy(input.prompt, {
      reply: this.buildFallbackFollowupReply({
        prompt: input.prompt,
        status: stepRun.status,
        stepError: stepRun.error_summary,
        artifactTitles,
        urls: this.extractUrls(stepArtifacts),
      }),
      decision: "no_rerun",
    });
  }

  private extractModelRerunDecision(raw: string): FollowupRerunDecision {
    const matches = [...raw.matchAll(/KOVALSKY_DECISION:\s*([^\r\n]+)/gi)];
    if (matches.length === 0) {
      return "unknown";
    }

    const value = (matches.at(-1)?.[1] ?? "").trim().toLowerCase();
    if (value === "rerun" || value === "yes" || value === "true") {
      return "rerun";
    }
    if (value === "no_rerun" || value === "no-rerun" || value === "no rerun" || value === "no" || value === "false") {
      return "no_rerun";
    }

    return "unknown";
  }

  private stripInlineDecisionMarkers(line: string): string {
    return line
      .replace(/\s*KOVALSKY_DECISION:\s*[^\r\n]+/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  private applyImmediateFollowupPolicy(prompt: string, result: FollowupReplyResult): FollowupReplyResult {
    if (!this.isImmediateStopServerRequest(prompt)) {
      return result;
    }

    return {
      reply: this.isLikelyRussianText(prompt)
        ? "Останавливаю сервер сейчас."
        : "Stopping the server now.",
      decision: "rerun",
    };
  }

  private isImmediateStopServerRequest(prompt: string): boolean {
    const normalized = prompt.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    if (/^(how|как)\b/.test(normalized)) {
      return false;
    }

    const hasImperative = /(останови|выключи|отключи|заверши|убей|stop|shutdown|shut\s+down|terminate|kill)/i.test(normalized);
    const hasTarget = /(server|сервер|port|порт|localhost|127\.0\.0\.1|background|фонов)/i.test(normalized);
    if (hasImperative && hasTarget) {
      return true;
    }

    return false;
  }

  private isLikelyRussianText(input: string): boolean {
    return /[А-Яа-яЁё]/.test(input);
  }

  private isImmediateExecutionRequest(prompt: string): boolean {
    const normalized = prompt.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    if (normalized.endsWith("?") || /^(how|what|why|when|where|who|как|что|почему|когда|где|кто|зачем)\b/i.test(normalized)) {
      return false;
    }

    return /(open|visit|browse|collect|send|write|create|update|run|execute|search|check|scrape|publish|deploy|открой|собери|отправ|запусти|выполни|сделай|проверь|найди|собирай|просматривай|опубликуй)/i
      .test(normalized);
  }

  private isLikelyOnboardingReply(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return /(who am i|who are you|what should i be called|what kind of.?creature|signature emoji|vibe\?|quick setup so i can work smoothly|then i can start your .* flow|как мне тебя называть|кто я|кто ты|выбери имя|подпись эмодзи|вайб)/i
      .test(normalized);
  }

  private isLikelyCapabilityDenialReply(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    return /(cannot|can't|unable|impossible|not possible|невозможно|не могу|не получится|нельзя|requires .*accountid|need .*accountid|бот.*должен.*подключ|telegram.*integration required|openclaw.*accountid)/i
      .test(normalized);
  }

  private isAwaitingUserInputReply(input: {
    reply: string;
    decision: FollowupRerunDecision;
  }): boolean {
    if (input.decision === "rerun") {
      return false;
    }

    const normalized = input.reply.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    if (/[?？]/.test(normalized)) {
      return true;
    }

    if (
      /\b(need|please provide|please confirm|confirm|can you|could you|which|what|when|where|share|specify|clarify)\b/i.test(
        normalized,
      )
    ) {
      return true;
    }

    if (/(нужн|подтвер|уточ|какой|какие|когда|где|сколько|можете|пришлите|укажи|уточни)/i.test(normalized)) {
      return true;
    }

    return false;
  }

  private buildStopServerOnlyGoal(existingGoal: string, prompt: string): string {
    const stopOnlyDirectives = [
      "Priority override: this rerun is ONLY for stopping the currently running local server/background process.",
      "Do NOT start any server in this rerun.",
      "Find and stop the process bound to the reported local URL/port from recent context.",
      "After stopping, verify the same URL no longer responds and the port is no longer listening.",
      `Latest user request: ${prompt.trim()}`,
    ];
    return `${stopOnlyDirectives.join("\n")}\n\nPrevious node goal and context:\n${existingGoal}`;
  }

  private resolveNodePlan(runId: string, node: PipelineGraphNode): NodeExecutionPlan {
    const plan = this.getRunPlan(runId);
    const fromPlan = plan?.nodes.find((item) => item.nodeId === node.id);
    if (fromPlan) {
      return fromPlan;
    }

    return {
      nodeId: node.id,
      agentId: node.agentId,
      goal: node.goal ?? "",
      receivesFrom: [],
      handoffTo: [],
      notes: [],
    };
  }

  private resolveWorkspacePathFromNodeChat(
    runId: string,
    nodeId: string,
    cachedMessages?: NodeMessageRecord[],
  ): string | null {
    const messages = cachedMessages ?? this.getPipelineNodeMessages(runId, nodeId);

    for (const message of messages) {
      if (!message.meta_json) {
        continue;
      }
      try {
        const meta = JSON.parse(message.meta_json) as { workspacePath?: unknown };
        if (typeof meta.workspacePath === "string" && meta.workspacePath.trim()) {
          return meta.workspacePath.trim();
        }
      } catch {
        continue;
      }
    }

    for (const message of messages) {
      const match = message.content.match(/^\s*Workspace:\s*(.+)$/im);
      if (match?.[1]) {
        const value = match[1].trim();
        if (value) {
          return value;
        }
      }
    }

    return null;
  }

  private getPipelineNodeMessages(runId: string, nodeId: string): NodeMessageRecord[] {
    const run = this.db.getRun(runId);
    if (!run) {
      return this.db.listNodeMessages(runId, nodeId);
    }
    return this.db.listNodeMessagesByPipelineNode(run.pipeline_id, nodeId);
  }

  private applyPipelineChatContextToGraph(graph: PipelineGraph, pipelineId: string): PipelineGraph {
    return {
      ...graph,
      nodes: graph.nodes.map((node) => {
        const chatContextMode = this.resolveNodeChatContextMode(node.settings);
        if (chatContextMode === "off") {
          return node;
        }

        const messages = this.db.listNodeMessagesByPipelineNode(pipelineId, node.id);
        const recentChatContext = this.buildPipelineChatContextSnippet(messages, chatContextMode);
        if (!recentChatContext) {
          return node;
        }

        const nextGoal = this.buildNodeGoalWithChatContext((node.goal ?? "").trim(), recentChatContext, undefined, chatContextMode);
        return {
          ...node,
          goal: nextGoal,
        };
      }),
    };
  }

  private applyPipelineFollowupToGraph(
    graph: PipelineGraph,
    nodeId: string,
    prompt: string,
    nodeMessages: NodeMessageRecord[],
  ): PipelineGraph {
    const followupPrompt = prompt.trim();
    if (!followupPrompt) {
      return graph;
    }

    return {
      ...graph,
      nodes: graph.nodes.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }

        const chatContextMode = this.resolveNodeChatContextMode(node.settings);
        const recentChatContext = chatContextMode === "off"
          ? ""
          : this.buildPipelineChatContextSnippet(nodeMessages, chatContextMode);
        const nextGoal = this.buildNodeGoalWithChatContext(
          (node.goal ?? "").trim(),
          recentChatContext,
          followupPrompt,
          chatContextMode,
        );

        return {
          ...node,
          goal: nextGoal,
        };
      }),
    };
  }

  private resolveNodeChatContextMode(settings: Record<string, unknown> | undefined): NodeChatContextMode {
    const raw = typeof settings?.chatContextMode === "string" ? settings.chatContextMode.trim().toLowerCase() : "";
    if (raw === "off" || raw === "strict") {
      return raw;
    }
    return "light";
  }

  private buildPipelineChatContextSnippet(messages: NodeMessageRecord[], mode: NodeChatContextMode): string {
    const sourceHistory = this.buildAssistantChatHistory(messages);
    const history = mode === "strict" ? sourceHistory.slice(-16) : sourceHistory.slice(-8);
    if (history.length === 0) {
      return "";
    }

    return history
      .map((item, index) => {
        const role = item.role === "user" ? "User" : "Assistant";
        return `${index + 1}. ${role}: ${this.truncateForGoal(item.content, mode === "strict" ? 420 : 240)}`;
      })
      .join("\n");
  }

  private buildNodeGoalWithChatContext(
    baseGoal: string,
    recentChatContext: string,
    followupPrompt?: string,
    mode: NodeChatContextMode = "light",
  ): string {
    const goal = baseGoal.trim();
    const followup = followupPrompt?.trim() ?? "";
    const context = recentChatContext.trim();

    if (mode === "strict" && followup) {
      const strictParts: string[] = [
        "Execution mode: STRICT_CHAT_OVERRIDE.",
        `Primary objective from latest workflow chat (execute now):\n${followup}`,
        "Conflict policy: if base goal or older context conflicts with the latest workflow chat objective, ignore conflicting parts and prioritize the latest workflow chat objective.",
        "Recovery policy: if latest message indicates previous expected result was not achieved yet, continue and complete the latest unresolved user action from recent chat context.",
      ];

      if (context) {
        strictParts.push(`Recent workflow chat context (strict mode):\n${context}`);
      }
      if (goal) {
        strictParts.push(`Base node goal (reference only):\n${goal}`);
      }
      return strictParts.join("\n\n");
    }

    const parts = [goal];
    if (followup) {
      parts.push(`Follow-up request from workflow chat:\n${followup}`);
    }
    if (context) {
      const label = mode === "strict" ? "Recent workflow chat context (strict mode)" : "Recent workflow chat context";
      parts.push(`${label}:\n${context}`);
    }
    if (mode === "strict") {
      parts.push("Chat-context mode is STRICT: if chat context conflicts with base goal, prioritize the latest user request from chat.");
    }
    return parts.filter(Boolean).join("\n\n");
  }

  private truncateForGoal(input: string, limit: number): string {
    const normalized = input.replace(/\s+/g, " ").trim();
    if (normalized.length <= limit) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
  }

  private buildAssistantChatHistory(messages: NodeMessageRecord[]): Array<{
    role: NodeMessageRole;
    content: string;
    createdAt: string;
  }> {
    return messages
      .filter((message) => message.role === "user" || message.role === "agent")
      .map((message) => ({
        role: message.role,
        content: message.role === "agent" ? this.sanitizeChatHistoryContent(message.content) : message.content,
        createdAt: message.created_at,
      }))
      .filter((message) => message.content.trim().length > 0);
  }

  private readStepLogTail(stepLogPath: string, maxLines: number): string[] {
    try {
      if (!fs.existsSync(stepLogPath)) {
        return [];
      }
      return fs
        .readFileSync(stepLogPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-maxLines)
        .map((line) => line.replace(/^\[(stdout|stderr)\]\s?/i, "").trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async buildAgentEnv(openaiCredentialId?: string): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
    };
    const settings = this.settingsService.getSettings();
    const openClawMode = settings.agents.openclaw.providerMode;
    const customOpenClawBaseUrl = this.normalizeOpenClawBaseUrl(settings.agents.openclaw.customApiBaseUrl);

    if (openaiCredentialId) {
      const explicit = await this.providerService.getCredentialSecret(openaiCredentialId);
      if (explicit) {
        env.OPENAI_API_KEY = explicit;
      }
    } else {
      const openai = await this.providerService.getLatestCredentialSecret("openai");
      if (openai) {
        env.OPENAI_API_KEY = openai;
      }
    }

    const codex = await this.providerService.getLatestCredentialSecret("codex");
    if (codex && this.looksLikeOpenAIApiKey(codex)) {
      env.CODEX_API_KEY = codex;
      if (!env.OPENAI_API_KEY) {
        env.OPENAI_API_KEY = codex;
      }
    }

    const openclaw = await this.providerService.getLatestCredentialSecret("openclaw");
    const codexAuth = readCodexAuthState(process.env);
    const codexAuthToken = codexAuth.authenticated ? codexAuth.token : "";
    let effectiveOpenClawToken = "";
    let openClawTokenSource: OpenClawTokenSource = "none";
    if (openClawMode === "custom") {
      effectiveOpenClawToken = openclaw || "";
      openClawTokenSource = openclaw ? "openclaw_credential" : "none";
      if (customOpenClawBaseUrl) {
        env.OPENAI_BASE_URL = customOpenClawBaseUrl;
        env.OPENCLAW_BASE_URL = customOpenClawBaseUrl;
        env.OPENCLAW_MODELS_PROVIDERS_OPENAI_BASE_URL = customOpenClawBaseUrl;
        env.OPENCLAW_MODELS_PROVIDERS_OPENAI_BASEURL = customOpenClawBaseUrl;
      }
    } else {
      if (openclaw) {
        effectiveOpenClawToken = openclaw;
        openClawTokenSource = "openclaw_credential";
      } else if (codexAuthToken) {
        effectiveOpenClawToken = codexAuthToken;
        openClawTokenSource = "codex_oauth";
      }
    }

    if (effectiveOpenClawToken) {
      env.OPENCLAW_API_KEY = effectiveOpenClawToken;
      env.OPENCLAW_TOKEN = effectiveOpenClawToken;
      if (!env.OPENAI_API_KEY && this.looksLikeOpenAIApiKey(effectiveOpenClawToken)) {
        env.OPENAI_API_KEY = effectiveOpenClawToken;
      }
    }

    const openClawStateDir = this.resolveOpenClawStateDir();
    env.OPENCLAW_STATE_DIR = openClawStateDir;
    this.bootstrapOpenClawState({
      stateDir: openClawStateDir,
      token: effectiveOpenClawToken,
      tokenSource: openClawTokenSource,
      providerMode: openClawMode,
      customApiBaseUrl: customOpenClawBaseUrl,
    });
    try {
      await this.ensureOpenClawGatewayReady(env, openClawStateDir);
    } catch (error) {
      this.logger.warn({ err: error, openClawStateDir }, "failed to bootstrap openclaw gateway");
    }

    return env;
  }

  private resolveOpenClawStateDir(): string {
    const explicit = (process.env.OPENCLAW_STATE_DIR ?? "").trim();
    if (explicit) {
      return explicit;
    }
    return path.join(this.resolveDefaultAppDataDir(), "openclaw-state");
  }

  private resolveDefaultAppDataDir(): string {
    return (process.env.KOVALSKY_APPDATA_DIR ?? "").trim() || path.join(os.homedir(), ".kovalsky");
  }

  private ensureOpenClawOpenAiProviderConfig(config: Record<string, unknown>, customApiBaseUrl: string): void {
    const models = (config.models && typeof config.models === "object")
      ? { ...(config.models as Record<string, unknown>) }
      : {};
    const providers = (models.providers && typeof models.providers === "object")
      ? { ...(models.providers as Record<string, unknown>) }
      : {};
    const openaiProvider = (providers.openai && typeof providers.openai === "object")
      ? { ...(providers.openai as Record<string, unknown>) }
      : {};

    const existingBaseUrl = typeof openaiProvider.baseUrl === "string" ? openaiProvider.baseUrl.trim() : "";
    const baseUrl = customApiBaseUrl || existingBaseUrl || "https://api.openai.com/v1";
    const existingModels = Array.isArray(openaiProvider.models)
      ? openaiProvider.models
          .map((item) => {
            if (item && typeof item === "object" && !Array.isArray(item)) {
              return item as Record<string, unknown>;
            }
            if (typeof item === "string" && item.trim().length > 0) {
              return {
                id: item.trim(),
                name: item.trim(),
              } as Record<string, unknown>;
            }
            return null;
          })
          .filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
    const modelsList = existingModels.length > 0
      ? existingModels
      : [
          {
            id: "gpt-5.1-codex",
            name: "GPT-5.1 Codex",
          },
        ];

    openaiProvider.baseUrl = baseUrl;
    openaiProvider.models = modelsList;
    providers.openai = openaiProvider;
    models.providers = providers;
    config.models = models;
  }

  private ensureOpenClawGatewayConfig(config: Record<string, unknown>): void {
    const gateway = (config.gateway && typeof config.gateway === "object")
      ? { ...(config.gateway as Record<string, unknown>) }
      : {};

    const currentMode = typeof gateway.mode === "string" ? gateway.mode.trim().toLowerCase() : "";
    if (!currentMode) {
      gateway.mode = "local";
    }

    const currentBind = typeof gateway.bind === "string" ? gateway.bind.trim().toLowerCase() : "";
    if (!currentBind) {
      gateway.bind = "loopback";
    }

    const currentPort = this.normalizeGatewayPort(gateway.port);
    if (currentPort === null) {
      gateway.port = this.resolveDefaultOpenClawGatewayPort();
    }

    config.gateway = gateway;
  }

  private resolveDefaultOpenClawBrowserProfile(): string {
    const explicit = (process.env.KOVALSKY_OPENCLAW_BROWSER_DEFAULT_PROFILE ?? "").trim();
    if (explicit) {
      return explicit;
    }
    return "openclaw";
  }

  private ensureOpenClawBrowserConfig(config: Record<string, unknown>): void {
    const browser = (config.browser && typeof config.browser === "object")
      ? { ...(config.browser as Record<string, unknown>) }
      : {};

    const preferredDefaultProfile = this.resolveDefaultOpenClawBrowserProfile().trim();
    const currentDefaultProfile = typeof browser.defaultProfile === "string"
      ? browser.defaultProfile.trim()
      : "";
    const normalizedCurrent = currentDefaultProfile.toLowerCase();
    const shouldApplyPreferred = !currentDefaultProfile || normalizedCurrent === "chrome";
    if (shouldApplyPreferred && preferredDefaultProfile) {
      browser.defaultProfile = preferredDefaultProfile;
    }

    const normalizedEffective = typeof browser.defaultProfile === "string"
      ? browser.defaultProfile.trim().toLowerCase()
      : "";
    if (normalizedEffective === "openclaw") {
      if ("cdpUrl" in browser) {
        delete browser.cdpUrl;
      }
      const profiles = (browser.profiles && typeof browser.profiles === "object")
        ? { ...(browser.profiles as Record<string, unknown>) }
        : {};
      if ("chrome" in profiles) {
        delete profiles.chrome;
      }
      browser.profiles = profiles;
    }

    config.browser = browser;
  }

  private resolveDefaultOpenClawGatewayPort(): number {
    const explicit = this.normalizeGatewayPort(process.env.KOVALSKY_OPENCLAW_GATEWAY_PORT);
    if (explicit !== null) {
      return explicit;
    }
    return DEFAULT_OPENCLAW_GATEWAY_PORT;
  }

  private normalizeGatewayPort(value: unknown): number | null {
    const parsed = typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : NaN;
    if (!Number.isFinite(parsed)) {
      return null;
    }
    const normalized = Math.floor(parsed);
    if (normalized < 1 || normalized > 65535) {
      return null;
    }
    return normalized;
  }

  private resolveDesiredOpenClawGatewayPort(stateDir: string): number {
    const configPath = path.join(stateDir, "openclaw.json");
    const config = this.readJsonObject(configPath);
    const gatewayValue = config.gateway;
    const gateway = gatewayValue && typeof gatewayValue === "object" && !Array.isArray(gatewayValue)
      ? gatewayValue as Record<string, unknown>
      : null;
    const configuredPort = this.normalizeGatewayPort(gateway?.port);
    if (configuredPort !== null) {
      return configuredPort;
    }
    return this.resolveDefaultOpenClawGatewayPort();
  }

  private async ensureOpenClawGatewayReady(env: NodeJS.ProcessEnv, stateDir: string): Promise<void> {
    const now = Date.now();
    const lastCheckedAt = this.openClawGatewayLastCheckedAt.get(stateDir) ?? 0;
    if (now - lastCheckedAt < OPENCLAW_GATEWAY_ENSURE_INTERVAL_MS) {
      return;
    }

    const inFlight = this.openClawGatewayEnsureLocks.get(stateDir);
    if (inFlight) {
      await inFlight;
      return;
    }

    const ensurePromise = this.ensureOpenClawGatewayReadyInternal(env, stateDir)
      .then(() => {
        this.openClawGatewayLastCheckedAt.set(stateDir, Date.now());
      })
      .finally(() => {
        this.openClawGatewayEnsureLocks.delete(stateDir);
      });

    this.openClawGatewayEnsureLocks.set(stateDir, ensurePromise);
    await ensurePromise;
  }

  private async ensureOpenClawGatewayReadyInternal(env: NodeJS.ProcessEnv, stateDir: string): Promise<void> {
    const invocation = await this.agentHost.resolveAgentInvocation({
      agentId: "openclaw",
      command: "openclaw",
      args: [],
    });

    const desiredPort = this.resolveDesiredOpenClawGatewayPort(stateDir);
    const statusBefore = this.runOpenClawGatewayCommand(invocation, ["gateway", "status", "--json"], env, stateDir);
    const beforeHealthy = this.isOpenClawGatewayHealthy(statusBefore.output, desiredPort);
    if (statusBefore.ok && beforeHealthy) {
      return;
    }

    this.logger.info({
      openClawStateDir: stateDir,
      desiredPort,
      statusCode: statusBefore.statusCode,
    }, "openclaw gateway is not ready, attempting bootstrap");

    const install = this.runOpenClawGatewayCommand(
      invocation,
      ["gateway", "install", "--force", "--runtime", "node"],
      env,
      stateDir,
    );
    if (!install.ok) {
      throw new Error(this.formatGatewayCommandFailure("install", install));
    }

    const start = this.runOpenClawGatewayCommand(invocation, ["gateway", "start"], env, stateDir);
    if (!start.ok) {
      throw new Error(this.formatGatewayCommandFailure("start", start));
    }

    const statusAfter = this.runOpenClawGatewayCommand(invocation, ["gateway", "status", "--json"], env, stateDir);
    if (!statusAfter.ok || !this.isOpenClawGatewayHealthy(statusAfter.output, desiredPort)) {
      throw new Error(this.formatGatewayCommandFailure("status", statusAfter));
    }
  }

  private runOpenClawGatewayCommand(
    invocation: { command: string; args: string[] },
    args: string[],
    env: NodeJS.ProcessEnv,
    stateDir: string,
  ): {
    ok: boolean;
    statusCode: number | null;
    output: string;
    error: string | null;
  } {
    const result = spawnSync(invocation.command, [...invocation.args, ...args], {
      cwd: os.homedir(),
      env: {
        ...env,
        OPENCLAW_STATE_DIR: stateDir,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENCLAW_GATEWAY_COMMAND_TIMEOUT_MS,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const error = result.error ? (result.error.message || String(result.error)) : null;
    return {
      ok: result.status === 0 && !error,
      statusCode: result.status ?? null,
      output,
      error,
    };
  }

  private isOpenClawGatewayHealthy(rawStatus: string, desiredPort: number): boolean {
    const status = this.parseOpenClawGatewayStatus(rawStatus);
    if (!status) {
      return false;
    }
    if (!status.rpcOk) {
      return false;
    }
    if (status.port !== null && status.port !== desiredPort) {
      return false;
    }
    return true;
  }

  private parseOpenClawGatewayStatus(raw: string): { rpcOk: boolean; port: number | null } | null {
    const parsed = this.parseJsonObjectFromText(raw);
    if (!parsed) {
      return null;
    }

    const rpcValue = parsed.rpc;
    const rpc = rpcValue && typeof rpcValue === "object" && !Array.isArray(rpcValue)
      ? rpcValue as Record<string, unknown>
      : null;
    const rpcOk = rpc?.ok === true;

    const gatewayValue = parsed.gateway;
    const gateway = gatewayValue && typeof gatewayValue === "object" && !Array.isArray(gatewayValue)
      ? gatewayValue as Record<string, unknown>
      : null;
    const port = this.normalizeGatewayPort(gateway?.port);
    return {
      rpcOk,
      port,
    };
  }

  private parseJsonObjectFromText(raw: string): Record<string, unknown> | null {
    const normalized = raw.trim();
    if (!normalized) {
      return null;
    }

    const candidates: string[] = [normalized];
    const start = normalized.indexOf("{");
    const end = normalized.lastIndexOf("}");
    if (start >= 0 && end > start) {
      candidates.push(normalized.slice(start, end + 1));
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Try next candidate.
      }
    }

    return null;
  }

  private formatGatewayCommandFailure(
    operation: "install" | "start" | "status",
    result: { statusCode: number | null; output: string; error: string | null },
  ): string {
    const output = result.output.trim();
    const summary = output
      ? output.split(/\r?\n/).filter(Boolean).slice(-6).join(" | ")
      : "no output";
    const statusCode = result.statusCode === null ? "null" : String(result.statusCode);
    if (result.error) {
      return `OpenClaw gateway ${operation} failed (${result.error}; exit=${statusCode}): ${summary}`;
    }
    return `OpenClaw gateway ${operation} failed (exit=${statusCode}): ${summary}`;
  }

  private resolveDefaultOpenClawModel(input: {
    providerMode: OpenClawProviderMode;
    token: string;
    tokenSource: OpenClawTokenSource;
  }): string {
    const explicitDefault = (process.env.KOVALSKY_OPENCLAW_DEFAULT_MODEL ?? "").trim();
    if (explicitDefault) {
      return explicitDefault;
    }

    const isOpenAiApiKey = this.looksLikeOpenAIApiKey(input.token);
    if (input.providerMode === "custom" || isOpenAiApiKey) {
      return "openai/gpt-5.1-codex";
    }

    // For any non-OpenAI-key auth token (OAuth-style), prefer a model id known by current OpenClaw versions.
    const codexOauthDefault = (process.env.KOVALSKY_OPENCLAW_CODEX_OAUTH_MODEL ?? "").trim();
    return codexOauthDefault || "openai-codex/gpt-5.2-codex";
  }

  private isUnsupportedCodexOauthModel(model: string): boolean {
    const normalized = model.trim().toLowerCase();
    return normalized === "openai-codex/gpt-5.3-codex"
      || normalized === "gpt-5.3-codex"
      || normalized === "openai-codex/gpt-5.3-codex-spark"
      || normalized === "gpt-5.3-codex-spark"
      || normalized === "openai-codex/gpt-5-codex"
      || normalized === "gpt-5-codex";
  }

  private normalizeCodexOauthAgentModelOverrides(agents: Record<string, unknown>, fallbackModel: string): void {
    const normalizedFallback = fallbackModel.trim();
    if (!normalizedFallback) {
      return;
    }

    const list = Array.isArray(agents.list) ? agents.list : [];
    if (list.length === 0) {
      return;
    }

    agents.list = list.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }

      const nextEntry = { ...(entry as Record<string, unknown>) };
      const currentModel = typeof nextEntry.model === "string" ? nextEntry.model.trim() : "";
      if (currentModel && this.isUnsupportedCodexOauthModel(currentModel)) {
        nextEntry.model = normalizedFallback;
      }
      return nextEntry;
    });
  }

  private bootstrapOpenClawState(input: {
    stateDir: string;
    token: string;
    tokenSource: OpenClawTokenSource;
    providerMode: OpenClawProviderMode;
    customApiBaseUrl: string;
  }): void {
    try {
      fs.mkdirSync(input.stateDir, { recursive: true });
      this.seedOpenClawStateFromNative(input.stateDir);
      const authPath = path.join(input.stateDir, "agents", "main", "agent", "auth-profiles.json");
      const legacyAuthPath = path.join(input.stateDir, "agents", "main", "agent", "auth.json");
      const configPath = path.join(input.stateDir, "openclaw.json");
      const isOpenAiApiKey = this.looksLikeOpenAIApiKey(input.token);

      if (input.token && !isOpenAiApiKey) {
        const authRaw = this.readJsonObject(authPath);
        const authStore = {
          version: 1,
          profiles: {},
          lastGood: {},
          usageStats: {},
          ...authRaw,
        } as {
          version: number;
          profiles: Record<string, unknown>;
          lastGood: Record<string, string>;
          usageStats: Record<string, unknown>;
        };

        authStore.version = 1;
        if (!authStore.profiles || typeof authStore.profiles !== "object") {
          authStore.profiles = {};
        }
        if (!authStore.lastGood || typeof authStore.lastGood !== "object") {
          authStore.lastGood = {};
        }
        if (!authStore.usageStats || typeof authStore.usageStats !== "object") {
          authStore.usageStats = {};
        }

        // When OpenClaw auth is sourced from Codex OAuth, prefer a token-based
        // profile wired to the latest Codex access token. This avoids stale
        // refresh-token state copied from legacy ~/.openclaw profiles.
        if (input.tokenSource === "codex_oauth") {
          const profileId = "openai-codex:gateway";
          authStore.profiles[profileId] = {
            type: "token",
            provider: "openai-codex",
            token: input.token,
          };
          authStore.lastGood["openai-codex"] = profileId;
          this.writeJsonObject(authPath, authStore);

          const legacyAuthRaw = this.readJsonObject(legacyAuthPath);
          const legacyOpenAiCodex = (legacyAuthRaw["openai-codex"] && typeof legacyAuthRaw["openai-codex"] === "object")
            ? { ...(legacyAuthRaw["openai-codex"] as Record<string, unknown>) }
            : {};
          legacyAuthRaw["openai-codex"] = {
            ...legacyOpenAiCodex,
            type: "token",
            token: input.token,
          };
          delete (legacyAuthRaw["openai-codex"] as Record<string, unknown>).refresh;
          delete (legacyAuthRaw["openai-codex"] as Record<string, unknown>).access;
          delete (legacyAuthRaw["openai-codex"] as Record<string, unknown>).expires;
          this.writeJsonObject(legacyAuthPath, legacyAuthRaw);
        }

        const hasCodexProfile = Object.entries(authStore.profiles).some(([profileId, profileValue]) => {
          if (profileId.trim().toLowerCase().startsWith("openai-codex:")) {
            return true;
          }
          return Boolean(
            profileValue
              && typeof profileValue === "object"
              && !Array.isArray(profileValue)
              && (profileValue as Record<string, unknown>).provider === "openai-codex",
          );
        });

        if (!hasCodexProfile) {
          const profileId = "openai-codex:gateway";
          authStore.profiles[profileId] = {
            type: "token",
            provider: "openai-codex",
            token: input.token,
          };
          authStore.lastGood["openai-codex"] = profileId;
          this.writeJsonObject(authPath, authStore);
        }
      }

      const configRaw = this.readJsonObject(configPath);
      const config = { ...configRaw } as Record<string, unknown>;
      const agents = (config.agents && typeof config.agents === "object")
        ? { ...(config.agents as Record<string, unknown>) }
        : {};
      const defaults = (agents.defaults && typeof agents.defaults === "object")
        ? { ...(agents.defaults as Record<string, unknown>) }
        : {};
      const model = (defaults.model && typeof defaults.model === "object")
        ? { ...(defaults.model as Record<string, unknown>) }
        : {};

      const resolvedDefaultModel = this.resolveDefaultOpenClawModel({
        providerMode: input.providerMode,
        token: input.token,
        tokenSource: input.tokenSource,
      });
      model.primary = resolvedDefaultModel;
      if (input.providerMode !== "custom" && !isOpenAiApiKey) {
        this.normalizeCodexOauthAgentModelOverrides(agents, resolvedDefaultModel);
      }
      defaults.model = model;
      defaults.timeoutSeconds = 600;
      agents.defaults = defaults;
      config.agents = agents;
      this.ensureOpenClawOpenAiProviderConfig(config, input.customApiBaseUrl);
      this.ensureOpenClawBrowserConfig(config);
      this.ensureOpenClawGatewayConfig(config);

      this.writeJsonObject(configPath, config);
    } catch (error) {
      this.logger.warn({ err: error }, "failed to bootstrap OpenClaw state");
    }
  }

  private seedOpenClawStateFromNative(targetStateDir: string): void {
    const nativeStateDir = this.resolveNativeOpenClawStateDir();
    if (!nativeStateDir) {
      return;
    }

    const filesToCopy = [
      ["agents/main/agent/auth-profiles.json", "agents/main/agent/auth-profiles.json", true],
      ["agents/main/agent/auth.json", "agents/main/agent/auth.json", true],
      ["identity/device.json", "identity/device.json", true],
      ["identity/device-auth.json", "identity/device-auth.json", true],
      ["devices/paired.json", "devices/paired.json", true],
      ["devices/pending.json", "devices/pending.json", true],
    ] as const;

    for (const [sourceRelativePath, targetRelativePath, overwriteExisting] of filesToCopy) {
      const sourcePath = path.join(nativeStateDir, sourceRelativePath);
      const targetPath = path.join(targetStateDir, targetRelativePath);
      if (!fs.existsSync(sourcePath) || (!overwriteExisting && fs.existsSync(targetPath))) {
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
      } catch {
        // Keep running even if native state is unavailable or unreadable.
      }
    }
  }

  private resolveNativeOpenClawStateDir(): string | null {
    const explicit = (process.env.KOVALSKY_OPENCLAW_NATIVE_STATE_DIR ?? "").trim();
    if (explicit && fs.existsSync(explicit)) {
      return explicit;
    }

    const homeCandidate = path.join(os.homedir(), ".openclaw");
    if (fs.existsSync(homeCandidate)) {
      return homeCandidate;
    }
    return null;
  }

  private readJsonObject(filePath: string): Record<string, unknown> {
    try {
      if (!fs.existsSync(filePath)) {
        return {};
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private writeJsonObject(filePath: string, payload: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  private looksLikeOpenAIApiKey(value: string): boolean {
    return /^sk-[A-Za-z0-9]/.test(value.trim());
  }

  private normalizeOpenClawBaseUrl(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "";
      }
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return "";
    }
  }

  private cleanReportReply(raw: string): string {
    const normalizedRaw = raw.replace(/```[\s\S]*?```/g, "\n");
    const lines = normalizedRaw
      .split(/\r?\n/)
      .map((line) => this.stripInlineDecisionMarkers(line))
      .filter(Boolean)
      .filter((line) => !/^step completed successfully\.?$/i.test(line))
      .filter((line) => !/^agent$/i.test(line))
      .filter((line) => !/^you$/i.test(line))
      .filter((line) => !/^post-step report:?$/i.test(line))
      .filter((line) => !/^\[tools\]/i.test(line))
      .filter((line) => !/^command exited with code/i.test(line))
      .filter((line) => !/^\s*[\[\]{}(),:]+\s*$/.test(line))
      .filter((line) => !/^"?(schemaChars|summaryChars|propertiesCount|requiredCount|name)"?\s*:/i.test(line))
      .filter((line) => !/^(mcp:|mcp startup:)/i.test(line))
      .filter((line) => !/^tokens used$/i.test(line))
      .filter((line) => !/^\d[\d\s]{2,}$/.test(line))
      .filter((line) => !/^[-+]\s+[+-]/.test(line))
      .filter((line) => !/^[-+]\s*<\/?[a-z][\w:-]*/i.test(line))
      .filter((line) => !/^diff --git /i.test(line))
      .filter((line) => line.toLowerCase() !== "codex")
      .filter((line) => line.toLowerCase() !== "openclaw")
      .filter((line) => !/^kovalsky_decision:/i.test(line))
      .filter((line) => !/^answer directly and naturally like an assistant/i.test(line))
      .filter((line) => !/^if data is insufficient, ask one concise clarifying question/i.test(line))
      .filter((line) => !/(who am i|who are you|what should i be called|what kind of.?creature|signature emoji|vibe\?|quick setup so i can work smoothly|как мне тебя называть|кто я|кто ты|выбери имя|подпись эмодзи|вайб)/i.test(line))
      .filter((line) => !this.looksLikeCodeLine(line));

    if (lines.length === 0) {
      return "";
    }

    const combined = lines
      .filter((line, index) => index === 0 || line !== lines[index - 1])
      .join("\n")
      .replace(/^Post-step report:\s*/i, "")
      .trim();
    const hasReadableText = /[A-Za-zА-Яа-яЁё]{4}/.test(combined);
    return hasReadableText ? combined : "";
  }

  private looksLikeCodeLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) {
      return false;
    }

    if (/^`{3,}/.test(trimmed)) {
      return true;
    }
    if (/^(const|let|var|function|class|interface|type|enum|import|export|return|if|for|while|switch|case|try|catch|finally|async|await)\b/.test(trimmed)) {
      return true;
    }
    if (/^\s*<\/?[a-z][\w:-]*(\s+[^>]*)?>\s*$/i.test(trimmed)) {
      return true;
    }
    if (/^[.#]?[A-Za-z_][\w-]*\s*\{/.test(trimmed)) {
      return true;
    }
    if (/^\$?\s*(pnpm|npm|yarn|node|python|python3|git|cd)\b/.test(trimmed)) {
      return true;
    }
    if (/^(diff --git|@@\s|index\s+[0-9a-f]+\.\.[0-9a-f]+)/i.test(trimmed)) {
      return true;
    }
    if (/^[+\-]\s*(const|let|var|function|class|interface|type|enum|import|export|return|if|for|while|switch|try|catch|finally|<|{|}|#)/.test(trimmed)) {
      return true;
    }

    const letterCount = (trimmed.match(/[A-Za-zА-Яа-яЁё]/g) ?? []).length;
    const symbolCount = (trimmed.match(/[{}<>`;$=]/g) ?? []).length;
    if (letterCount < 3 && symbolCount >= 2) {
      return true;
    }

    return false;
  }

  private sanitizeChatHistoryContent(raw: string): string {
    return raw
      .split(/\r?\n/)
      .map((line) => this.stripInlineDecisionMarkers(line))
      .filter(Boolean)
      .filter((line) => !/^step completed successfully\.?$/i.test(line))
      .filter((line) => !/^agent$/i.test(line))
      .filter((line) => !/^you$/i.test(line))
      .filter((line) => !/^post-step report:?$/i.test(line))
      .filter((line) => !/^(mcp:|mcp startup:)/i.test(line))
      .filter((line) => !/^tokens used$/i.test(line))
      .filter((line) => !/^\d[\d\s]{2,}$/.test(line))
      .filter((line) => !/^[-+]\s+[+-]/.test(line))
      .filter((line) => !/^[-+]\s*<\/?[a-z][\w:-]*/i.test(line))
      .filter((line) => !/^diff --git /i.test(line))
      .filter((line) => !/^kovalsky_decision:/i.test(line))
      .filter((line) => !/^answer directly and naturally like an assistant/i.test(line))
      .filter((line) => !/^at the very end add one strict machine-readable line:/i.test(line))
      .filter((line) => !/^use rerun only when the user clearly asks to perform edits\/actions now/i.test(line))
      .filter((line) => !/^if data is insufficient, ask one concise clarifying question/i.test(line))
      .filter((line) => !/(who am i|who are you|what should i be called|what kind of.?creature|signature emoji|vibe\?|quick setup so i can work smoothly|как мне тебя называть|кто я|кто ты|выбери имя|подпись эмодзи|вайб)/i.test(line))
      .join("\n")
      .replace(/^Post-step report:\s*/i, "")
      .trim();
  }

  private buildNoStepReply(prompt: string): string {
    return "This node has no completed step yet. Run the workflow first, then request a report in chat.";
  }

  private buildFallbackFollowupReply(input: {
    prompt: string;
    status: StepStatus;
    stepError: string | null;
    artifactTitles: string[];
    urls: string[];
  }): string {
    const statusLine = `Step status: ${input.status}`;
    const intro = "Understood. Here is what I can see from this run:";
    const lines: string[] = [intro, statusLine];

    if (input.stepError) {
      lines.push(`Failure reason: ${input.stepError}`);
    }

    if (input.urls.length > 0) {
      lines.push("Check these first:");
      for (const url of input.urls.slice(0, 5)) {
        lines.push(`- ${url}`);
      }
    }

    if (input.artifactTitles.length > 0) {
      lines.push("Available artifacts:");
      for (const titleItem of input.artifactTitles.slice(0, 8)) {
        lines.push(`- ${titleItem}`);
      }
    }

    if (input.status !== "success") {
      lines.push("If you want, I can immediately suggest a step-by-step fix for your request.");
    }

    return lines.join("\n");
  }

  private extractUrls(artifacts: ArtifactRecord[]): string[] {
    const urls = new Set<string>();
    for (const artifact of artifacts) {
      if (artifact.meta_json) {
        try {
          const meta = JSON.parse(artifact.meta_json) as { url?: unknown; urls?: unknown };
          if (Array.isArray(meta.urls)) {
            for (const item of meta.urls) {
              if (typeof item !== "string") {
                continue;
              }
              const normalized = normalizeUrlCandidate(item);
              if (normalized) {
                urls.add(normalized);
              }
            }
          }
          if (typeof meta.url === "string") {
            const normalized = normalizeUrlCandidate(meta.url);
            if (normalized) {
              urls.add(normalized);
            }
          }
        } catch {
          // ignore malformed metadata
        }
      }

      const fromPath = normalizeUrlCandidate(artifact.path);
      if (fromPath) {
        urls.add(fromPath);
      }

      if (!fs.existsSync(artifact.path)) {
        continue;
      }

      try {
        const content = fs.readFileSync(artifact.path, "utf8");
        const match = content.match(/https?:\/\/[^\s"'`]+/g) ?? [];
        for (const item of match) {
          const normalized = normalizeUrlCandidate(item);
          if (normalized) {
            urls.add(normalized);
          }
        }
      } catch {
        continue;
      }
    }

    return [...urls];
  }

  private buildDeterministicPlan(runId: string, pipelineId: string, graph: PipelineGraph): RunPlanData {
    const incoming = new Map<string, string[]>();
    const outgoing = new Map<string, string[]>();
    const loopNodeIds = new Set(
      graph.nodes
        .filter((node) => node.agentId === "loop")
        .map((node) => node.id),
    );
    for (const node of graph.nodes) {
      incoming.set(node.id, []);
      outgoing.set(node.id, []);
    }

    for (const edge of graph.edges) {
      if (loopNodeIds.has(edge.source)) {
        // loopback edges are continuation links for the next cycle, not same-run dependencies.
        continue;
      }
      incoming.get(edge.target)?.push(edge.source);
      outgoing.get(edge.source)?.push(edge.target);
    }

    const nodes = graph.nodes.map((node) => ({
      nodeId: node.id,
      agentId: node.agentId,
      goal: node.goal ?? "",
      receivesFrom: incoming.get(node.id) ?? [],
      handoffTo: (outgoing.get(node.id) ?? []).map((targetNodeId) => ({
        nodeId: targetNodeId,
        context: `Pass a concise handoff to node ${targetNodeId}: what was done, what changed, what to run, and how to verify.`,
        launchHints: [],
      })),
      notes: ["Deterministic handoff plan (planner disabled)."],
    }));

    return {
      runId,
      pipelineId,
      createdAt: nowIso(),
      nodes,
      issues: [],
      isExecutable: true,
    };
  }

  private hasInProgressStepRuns(runId: string): boolean {
    return this.db
      .getStepRunsByRun(runId)
      .some((step) => step.status === "pending" || step.status === "running");
  }

  private reconcileRunStatusFromLatestSteps(runId: string): {
    status: "running" | "success" | "failed" | "canceled";
    errorSummary: string | null;
  } {
    const stepRuns = this.db.getStepRunsByRun(runId);
    if (stepRuns.length === 0) {
      return { status: "success", errorSummary: null };
    }

    const latestByNode = new Map<string, StepRunRecord>();
    for (const step of stepRuns) {
      const current = latestByNode.get(step.node_id);
      if (!current || this.isStepRunNewer(step, current)) {
        latestByNode.set(step.node_id, step);
      }
    }

    const latest = [...latestByNode.values()];
    if (latest.some((step) => step.status === "pending" || step.status === "running")) {
      return { status: "running", errorSummary: null };
    }

    const failed = latest.find((step) => step.status === "failed");
    if (failed) {
      return {
        status: "failed",
        errorSummary: failed.error_summary ?? "Step failed",
      };
    }

    if (latest.every((step) => step.status === "canceled")) {
      return { status: "canceled", errorSummary: "Run canceled by user" };
    }

    return { status: "success", errorSummary: null };
  }

  private isStepRunNewer(left: StepRunRecord, right: StepRunRecord): boolean {
    const leftAt = left.started_at ?? left.finished_at ?? "";
    const rightAt = right.started_at ?? right.finished_at ?? "";
    if (leftAt === rightAt) {
      return left.id.localeCompare(right.id) > 0;
    }
    return leftAt.localeCompare(rightAt) > 0;
  }

  private async markRunCanceled(runId: string, reason: string): Promise<void> {
    const stepRuns = this.db.getStepRunsByRun(runId);

    for (const step of stepRuns) {
      if (step.status !== "pending" && step.status !== "running") {
        continue;
      }
      this.db.updateStepRunStatus(step.id, "canceled", null, reason);
      this.eventBus.emit({
        runId,
        type: "step_status",
        at: new Date().toISOString(),
        payload: {
          nodeId: step.node_id,
          stepRunId: step.id,
          status: "canceled",
        },
      });
    }

    this.db.updateRunStatus(runId, "canceled", reason);
    this.eventBus.emit({
      runId,
      type: "run_status",
      at: new Date().toISOString(),
      payload: {
        status: "canceled",
        errorSummary: reason,
      },
    });

    await Promise.all(
      stepRuns.map((step) => this.graphExecutor.cancelStepRun(step.id).catch(() => undefined)),
    );
  }

  private buildPlanSummary(nodePlan: RunPlanData["nodes"][number]): string {
    const receives = nodePlan.receivesFrom.length > 0 ? nodePlan.receivesFrom.join(", ") : "none";
    const handoffTo = nodePlan.handoffTo.length > 0
      ? nodePlan.handoffTo.map((item) => item.nodeId).join(", ")
      : "none";
    const notes = nodePlan.notes.length > 0 ? nodePlan.notes.join(" | ") : "none";

    return [
      `Goal: ${nodePlan.goal || "(empty)"}`,
      `Receives from: ${receives}`,
      `Handoff to: ${handoffTo}`,
      `Notes: ${notes}`,
    ].join("\n");
  }

  private prepareWorkspaceReportLink(runId: string, workspacePath: string): string {
    const reportRoot = path.join(workspacePath, "kovalsky-report");
    fs.mkdirSync(reportRoot, { recursive: true });

    const runReportPath = path.join(reportRoot, runId);
    if (fs.existsSync(runReportPath)) {
      fs.rmSync(runReportPath, { recursive: true, force: true });
    }

    const runArtifactsPath = this.artifactStore.getRunDir(runId);
    try {
      const symlinkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(runArtifactsPath, runReportPath, symlinkType);
    } catch {
      fs.mkdirSync(runReportPath, { recursive: true });
      fs.writeFileSync(
        path.join(runReportPath, "README.txt"),
        [
          "Run artifacts are stored in application data.",
          `Source: ${runArtifactsPath}`,
        ].join("\n"),
        "utf8",
      );
    }

    return runReportPath;
  }
}
