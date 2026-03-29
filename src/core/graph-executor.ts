import fs from "node:fs";
import path from "node:path";
import type pino from "pino";
import { ArtifactResolver } from "../artifacts/resolver";
import { ArtifactStore } from "../artifacts/store";
import { DatabaseService } from "../db";
import { PluginRegistry } from "../plugins/registry";
import type {
  ArtifactRecord,
  NodeExecutionPlan,
  PipelineGraph,
  PipelineGraphNode,
  ResolvedInputs,
  RunPlanData,
  RunStatus,
  StepStatus,
} from "../types";
import { AgentHost } from "./agent-host";
import type { EventBus } from "./event-bus";
import { extractUrlsFromText, normalizeUrlCandidate } from "../utils/url";

export interface ExecutionOverrides {
  workspacePath: string;
  maxParallelSteps?: number;
  stopOnFailure?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunControl {
  isCanceled(): boolean;
}

export interface LoopContinuationRequest {
  sourceNodeId: string;
  targetNodeIds: string[];
  delaySeconds: number;
  carryContext: boolean;
}

export interface RunExecutionResult {
  status: RunStatus;
  loopContinuation: LoopContinuationRequest | null;
}

export class GraphExecutor {
  private readonly activeStepRunsByRun = new Map<string, Set<string>>();
  private readonly activeReportStepRunsByRun = new Map<string, Set<string>>();
  private static readonly DEFAULT_SELF_HEAL_ATTEMPTS = 1;
  private static readonly DEFAULT_SELF_HEAL_ATTEMPTS_FOR_LLM = 3;
  private static readonly MAX_SELF_HEAL_ATTEMPTS = 6;

  constructor(
    private readonly db: DatabaseService,
    private readonly pluginRegistry: PluginRegistry,
    private readonly artifactResolver: ArtifactResolver,
    private readonly artifactStore: ArtifactStore,
    private readonly agentHost: AgentHost,
    private readonly eventBus: EventBus,
    private readonly logger: pino.Logger,
  ) {}

  async executeRun(
    runId: string,
    graph: PipelineGraph,
    runPlan: RunPlanData,
    overrides: ExecutionOverrides,
    control: RunControl,
  ): Promise<RunExecutionResult> {
    const maxParallel = Math.max(1, overrides.maxParallelSteps ?? 3);
    const stopOnFailure = overrides.stopOnFailure ?? true;
    this.activeStepRunsByRun.set(runId, new Set<string>());
    this.activeReportStepRunsByRun.set(runId, new Set<string>());

    if (control.isCanceled()) {
      this.db.updateRunStatus(runId, "canceled", "Run canceled by user");
      this.eventBus.emit({
        runId,
        type: "run_status",
        at: new Date().toISOString(),
        payload: {
          status: "canceled",
          errorSummary: "Run canceled by user",
        },
      });
      this.activeStepRunsByRun.delete(runId);
      this.activeReportStepRunsByRun.delete(runId);
      return {
        status: "canceled",
        loopContinuation: null,
      };
    }

    this.db.updateRunStatus(runId, "running", null);
    this.eventBus.emit({
      runId,
      type: "run_status",
      at: new Date().toISOString(),
      payload: { status: "running" },
    });

    const planByNode = new Map<string, NodeExecutionPlan>(runPlan.nodes.map((item) => [item.nodeId, item]));

    const outgoing = new Map<string, string[]>();
    const incomingCount = new Map<string, number>();
    const nodeById = new Map<string, PipelineGraphNode>();
    const stepRunByNode = new Map<string, string>();
    const loopTargetsByNode = new Map<string, string[]>();

    for (const node of graph.nodes) {
      outgoing.set(node.id, []);
      incomingCount.set(node.id, 0);
      nodeById.set(node.id, node);
      if (node.agentId === "loop") {
        loopTargetsByNode.set(node.id, []);
      }
      const stepRun = this.db.createStepRun(runId, node.id, node.agentId);
      stepRunByNode.set(node.id, stepRun.id);
      this.eventBus.emit({
        runId,
        type: "step_status",
        at: new Date().toISOString(),
        payload: {
          nodeId: node.id,
          stepRunId: stepRun.id,
          status: "pending",
        },
      });
      this.writeNodeMessage(runId, node.id, "system", "run", "Step is pending execution.");
    }

    for (const edge of graph.edges) {
      if (loopTargetsByNode.has(edge.source)) {
        loopTargetsByNode.get(edge.source)?.push(edge.target);
        continue;
      }
      outgoing.get(edge.source)?.push(edge.target);
      incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
    }

    const defaultLoopTargetNodeIds = [...incomingCount.entries()]
      .filter(([, count]) => count === 0)
      .map(([nodeId]) => nodeId)
      .filter((nodeId) => {
        const node = nodeById.get(nodeId);
        if (!node) {
          return false;
        }
        return node.agentId !== "loop" && node.agentId !== "trigger";
      });

    const ready: string[] = [...incomingCount.entries()]
      .filter(([, count]) => count === 0)
      .map(([nodeId]) => nodeId);

    const statusByNode = new Map<string, StepStatus>();
    const running = new Map<string, Promise<void>>();
    let fatalError: string | null = null;
    let loopContinuation: LoopContinuationRequest | null = null;

    const launchNode = (nodeId: string): Promise<void> => {
      const node = nodeById.get(nodeId);
      const stepRunId = stepRunByNode.get(nodeId);
      if (!node || !stepRunId) {
        throw new Error(`Missing node context for ${nodeId}`);
      }

      return (async () => {
        if (control.isCanceled()) {
          statusByNode.set(nodeId, "canceled");
          this.db.updateStepRunStatus(stepRunId, "canceled", null, "Run canceled");
          this.writeNodeMessage(runId, nodeId, "system", "run", "Step canceled before start.");
          return;
        }

        this.db.updateStepRunStatus(stepRunId, "running", null, null);
        this.eventBus.emit({
          runId,
          type: "step_status",
          at: new Date().toISOString(),
          payload: {
            nodeId,
            stepRunId,
            status: "running",
          },
        });

        const nodePlan = planByNode.get(nodeId) ?? {
          nodeId,
          agentId: node.agentId,
          goal: node.goal ?? "",
          receivesFrom: [],
          handoffTo: [],
          notes: [],
        };

        const effectiveGoal = [node.goal ?? "", nodePlan.goalAddendum ?? "", nodePlan.handoffContext ?? ""]
          .map((part) => part.trim())
          .filter(Boolean)
          .join("\n\n");
        const maxAttempts = this.resolveStepMaxAttempts(node.agentId, node.settings ?? {});
        const expectedOutputFiles = this.extractExpectedOutputFiles([
          node.goal ?? "",
          nodePlan.goalAddendum ?? "",
        ].filter(Boolean).join("\n"));

        this.writeNodeMessage(
          runId,
          nodeId,
          "system",
          "run",
          `Step running. Handoff targets: ${
            nodePlan.handoffTo.length > 0 ? nodePlan.handoffTo.map((item) => item.nodeId).join(", ") : "none"
          }${nodePlan.goalAddendum || nodePlan.handoffContext ? " | handoff addendum attached" : ""
          } | self-heal attempts: ${maxAttempts}`,
        );

        if (node.agentId === "trigger") {
          statusByNode.set(nodeId, "success");
          this.db.updateStepRunStatus(stepRunId, "success", 0, null);
          this.eventBus.emit({
            runId,
            type: "step_status",
            at: new Date().toISOString(),
            payload: {
              nodeId,
              stepRunId,
              status: "success",
            },
          });
          this.writeNodeMessage(
            runId,
            nodeId,
            "system",
            "run",
            "Trigger node is control-only. Direct run execution was skipped and downstream steps were unblocked.",
          );

          for (const next of outgoing.get(nodeId) ?? []) {
            incomingCount.set(next, (incomingCount.get(next) ?? 0) - 1);
            if (incomingCount.get(next) === 0) {
              ready.push(next);
            }
          }
          return;
        }

        if (node.agentId === "loop") {
          const delaySeconds = this.resolveLoopDelaySeconds(node.settings ?? {});
          const carryContext = this.resolveLoopCarryContext(node.settings ?? {});
          const explicitTargets = [...new Set(loopTargetsByNode.get(nodeId) ?? [])];
          const targetNodeIds = explicitTargets.length > 0 ? explicitTargets : defaultLoopTargetNodeIds;
          this.artifactStore.ensureStepDirs(runId, stepRunId);
          const loopStepLogPath = this.artifactStore.getStepLogPath(runId, stepRunId);

          statusByNode.set(nodeId, "success");
          this.db.updateStepRunStatus(stepRunId, "success", 0, null);
          this.eventBus.emit({
            runId,
            type: "step_status",
            at: new Date().toISOString(),
            payload: {
              nodeId,
              stepRunId,
              status: "success",
            },
          });

          if (targetNodeIds.length === 0) {
            this.appendStepLogLine(loopStepLogPath, "stdout", "Loop status: success (no restart targets).");
            this.writeNodeMessage(
              runId,
              nodeId,
              "system",
              "run",
              "Loop node completed. No restart targets are connected.",
            );
            return;
          }

          if (!loopContinuation) {
            loopContinuation = {
              sourceNodeId: nodeId,
              targetNodeIds,
              delaySeconds,
              carryContext,
            };
            this.appendStepLogLine(
              loopStepLogPath,
              "stdout",
              `Loop status: waiting (${delaySeconds}s). Targets: ${targetNodeIds.join(", ")}.`,
            );
            this.writeNodeMessage(
              runId,
              nodeId,
              "system",
              "run",
              `Loop requested next cycle in ${delaySeconds}s. Targets: ${targetNodeIds.join(", ")}.${explicitTargets.length === 0 ? " Mode: entrypoint fallback (no explicit loop edge)." : ""} Carry context: ${carryContext ? "yes" : "no"}.`,
            );
          } else {
            this.appendStepLogLine(loopStepLogPath, "stdout", "Loop status: success (request ignored: continuation already scheduled).");
            this.writeNodeMessage(
              runId,
              nodeId,
              "system",
              "run",
              "Loop request ignored because another loop continuation is already scheduled for this run.",
            );
          }

          return;
        }

        const plugin = this.pluginRegistry.get(node.agentId);
        if (!plugin) {
          const error = `Agent ${node.agentId} is not registered`;
          statusByNode.set(nodeId, "failed");
          this.db.updateStepRunStatus(stepRunId, "failed", 1, error);
          this.eventBus.emit({
            runId,
            type: "step_status",
            at: new Date().toISOString(),
            payload: {
              nodeId,
              stepRunId,
              status: "failed",
              error,
            },
          });
          this.writeNodeMessage(runId, nodeId, "system", "run", `Step failed: ${error}`);
          fatalError = fatalError ?? error;
          return;
        }

        this.artifactStore.ensureStepDirs(runId, stepRunId);
        const stepDir = this.artifactStore.getStepDir(runId, stepRunId);
        const stepLogPath = this.artifactStore.getStepLogPath(runId, stepRunId);

        let resolvedInputs: ResolvedInputs = {
          inputsByType: {},
          predecessorArtifacts: [],
          handoffs: [],
        };

        try {
          resolvedInputs = this.artifactResolver.resolveForStep(runId, graph, node.id, nodePlan);
          const preflightIssue = await this.preflightResolvedUrls(node.id, resolvedInputs);
          if (preflightIssue) {
            throw new Error(preflightIssue);
          }

          let success = false;
          let lastError: string | null = null;
          let lastExitCode: number | null = null;

          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (control.isCanceled()) {
              throw new Error("Run canceled");
            }

            const attemptGoal = this.buildAttemptGoal(effectiveGoal, attempt, maxAttempts, lastError);
            if (attempt > 1) {
              this.writeNodeMessage(
                runId,
                nodeId,
                "system",
                "run",
                `Self-heal retry ${attempt}/${maxAttempts}. Previous error: ${lastError ?? "unknown"}`,
              );
            }

            try {
              const result = await this.agentHost.runStep({
                agentId: node.agentId,
                context: {
                  runId,
                  stepRunId,
                  nodeId: node.id,
                  workspacePath: overrides.workspacePath,
                  stepDir,
                  stepLogPath,
                  goal: attemptGoal,
                  settings: node.settings ?? {},
                  plannedNode: nodePlan,
                  resolvedInputs,
                  env: {
                    ...process.env,
                    ...overrides.env,
                  },
                },
                timeoutMs: overrides.timeoutMs,
              });

              lastExitCode = result.exitCode;
              if (result.exitCode === 0) {
                const missingOutputFiles = this.findMissingExpectedOutputFiles(
                  overrides.workspacePath,
                  expectedOutputFiles,
                );
                if (missingOutputFiles.length > 0) {
                  const missingSummary = `Expected output files not found in workspace: ${missingOutputFiles.join(", ")}`;
                  this.appendStepLogLine(stepLogPath, "stderr", missingSummary);
                  lastExitCode = 1;
                  lastError = missingSummary;
                  continue;
                }

                const artifactTitles = result.artifactIds
                  .map((artifactId) => this.db.getArtifact(artifactId))
                  .filter((artifact): artifact is ArtifactRecord => Boolean(artifact))
                  .map((artifact) => `${artifact.title} (${artifact.type})`);
                this.triggerPostStepReport({
                  runId,
                  node,
                  stepRunId,
                  nodePlan,
                  workspacePath: overrides.workspacePath,
                  stepDir,
                  stepLogPath,
                  resolvedInputs,
                  env: {
                    ...process.env,
                    ...overrides.env,
                  },
                  status: "success",
                  errorSummary: null,
                  artifactTitles,
                  timeoutMs: overrides.timeoutMs,
                });
                success = true;
                break;
              }

              const detail = this.readLastStepError(stepLogPath);
              lastError = detail
                ? `Agent exited with code ${result.exitCode}: ${detail}`
                : `Agent exited with code ${result.exitCode}`;
            } catch (error) {
              lastError = error instanceof Error ? error.message : "Step execution failed";
            }

            if (attempt < maxAttempts) {
              this.writeNodeMessage(
                runId,
                nodeId,
                "agent",
                "run",
                `Attempt ${attempt} failed. Retrying with self-heal context...`,
              );
            }
          }

          if (!success) {
            const error = lastError ?? "Step execution failed";
            this.triggerPostStepReport({
              runId,
              node,
              stepRunId,
              nodePlan,
              workspacePath: overrides.workspacePath,
              stepDir,
              stepLogPath,
              resolvedInputs,
              env: {
                ...process.env,
                ...overrides.env,
              },
              status: "failed",
              errorSummary: error,
              artifactTitles: [],
              timeoutMs: overrides.timeoutMs,
            });
            statusByNode.set(nodeId, "failed");
            this.db.updateStepRunStatus(stepRunId, "failed", lastExitCode ?? 1, error);
            this.eventBus.emit({
              runId,
              type: "step_status",
              at: new Date().toISOString(),
              payload: {
                nodeId,
                stepRunId,
                status: "failed",
                error,
              },
            });
            this.writeNodeMessage(runId, nodeId, "agent", "run", `Step failed after ${maxAttempts} attempt(s): ${error}`);
            fatalError = fatalError ?? error;
            return;
          }

          statusByNode.set(nodeId, "success");
          this.db.updateStepRunStatus(stepRunId, "success", 0, null);
          this.eventBus.emit({
            runId,
            type: "step_status",
            at: new Date().toISOString(),
            payload: {
              nodeId,
              stepRunId,
              status: "success",
            },
          });
          this.writeNodeMessage(runId, nodeId, "agent", "run", "Step completed successfully.");

          for (const next of outgoing.get(nodeId) ?? []) {
            incomingCount.set(next, (incomingCount.get(next) ?? 0) - 1);
            if (incomingCount.get(next) === 0) {
              ready.push(next);
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Step execution failed";
          this.triggerPostStepReport({
            runId,
            node,
            stepRunId,
            nodePlan,
            workspacePath: overrides.workspacePath,
            stepDir,
            stepLogPath,
            resolvedInputs,
            env: {
              ...process.env,
              ...overrides.env,
            },
            status: "failed",
            errorSummary: message,
            artifactTitles: [],
            timeoutMs: overrides.timeoutMs,
          });
          this.logger.error({ err: error, runId, stepRunId }, "step failed");
          statusByNode.set(nodeId, "failed");
          this.db.updateStepRunStatus(stepRunId, "failed", 1, message);
          this.eventBus.emit({
            runId,
            type: "step_status",
            at: new Date().toISOString(),
            payload: {
              nodeId,
              stepRunId,
              status: "failed",
              error: message,
            },
          });
          this.writeNodeMessage(runId, nodeId, "system", "run", `Step failed: ${message}`);
          fatalError = fatalError ?? message;
        } finally {
          this.activeStepRunsByRun.get(runId)?.delete(stepRunId);
        }
      })();
    };

    while (statusByNode.size < graph.nodes.length) {
      if (control.isCanceled()) {
        await this.cancelRun(runId);
        break;
      }

      if (fatalError && stopOnFailure) {
        await this.cancelRun(runId);
        break;
      }

      while (running.size < maxParallel && ready.length > 0) {
        const nodeId = ready.shift() as string;
        if (statusByNode.has(nodeId)) {
          continue;
        }
        const promise = launchNode(nodeId).finally(() => {
          running.delete(nodeId);
        });
        this.activeStepRunsByRun.get(runId)?.add(stepRunByNode.get(nodeId) as string);
        running.set(nodeId, promise);
      }

      if (running.size === 0) {
        break;
      }

      await Promise.race(running.values());
    }

    await Promise.all(running.values());

    for (const node of graph.nodes) {
      if (!statusByNode.has(node.id)) {
        const stepRunId = stepRunByNode.get(node.id);
        if (!stepRunId) {
          continue;
        }
        const nextStatus: StepStatus = control.isCanceled() ? "canceled" : "skipped";
        this.db.updateStepRunStatus(stepRunId, nextStatus, null, control.isCanceled() ? "Run canceled" : "Skipped");
        this.eventBus.emit({
          runId,
          type: "step_status",
          at: new Date().toISOString(),
          payload: {
            nodeId: node.id,
            stepRunId,
            status: nextStatus,
          },
        });
        this.writeNodeMessage(runId, node.id, "system", "run", `Step ${nextStatus}.`);
      }
    }

    let runStatus: RunStatus;
    if (control.isCanceled()) {
      runStatus = "canceled";
      this.db.updateRunStatus(runId, "canceled", "Run canceled by user");
    } else if (fatalError) {
      runStatus = "failed";
      this.db.updateRunStatus(runId, "failed", fatalError);
    } else {
      runStatus = "success";
      this.db.updateRunStatus(runId, "success", null);
    }

    this.eventBus.emit({
      runId,
      type: "run_status",
      at: new Date().toISOString(),
      payload: {
        status: runStatus,
        errorSummary: fatalError,
      },
    });

    this.activeStepRunsByRun.delete(runId);
    this.activeReportStepRunsByRun.delete(runId);
    return {
      status: runStatus,
      loopContinuation: runStatus === "success" ? loopContinuation : null,
    };
  }

  async cancelRun(runId: string): Promise<void> {
    const stepRunIds = this.activeStepRunsByRun.get(runId);
    const reportStepRunIds = this.activeReportStepRunsByRun.get(runId);
    const keys = new Set<string>([
      ...(stepRunIds ? [...stepRunIds] : []),
      ...(reportStepRunIds ? [...reportStepRunIds] : []),
    ]);
    if (keys.size === 0) {
      return;
    }

    await Promise.all([...keys].map((stepRunId) => this.agentHost.cancelStep(stepRunId)));
  }

  async cancelStepRun(stepRunId: string): Promise<void> {
    await this.agentHost.cancelStep(stepRunId);
  }

  private writeNodeMessage(
    runId: string,
    nodeId: string,
    role: "system" | "agent",
    phase: "run",
    content: string,
  ): void {
    const message = this.db.createNodeMessage({
      runId,
      nodeId,
      role,
      phase,
      content,
    });

    this.eventBus.emit({
      runId,
      type: "chat_message",
      at: new Date().toISOString(),
      payload: {
        nodeId,
        message,
      },
    });
  }

  private triggerPostStepReport(params: {
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
    timeoutMs?: number;
  }): void {
    if (!this.shouldRunPostStepReport(params.node.agentId, params.node.settings ?? {})) {
      return;
    }

    if (params.node.agentId === "openclaw") {
      const extracted = this.extractOpenClawPayloadTextFromLog(params.stepLogPath);
      if (extracted) {
        this.writeNodeMessage(params.runId, params.node.id, "agent", "run", `Post-step report:\n${extracted}`);
        return;
      }

      const content = this.buildOpenClawPostStepReport({
        status: params.status,
        errorSummary: params.errorSummary,
        artifactTitles: params.artifactTitles,
        logTail: this.readStepLogTail(params.stepLogPath, 20),
      });
      if (content) {
        this.writeNodeMessage(params.runId, params.node.id, "agent", "run", `Post-step report:\n${content}`);
      }
      return;
    }

    const reportTimeoutMs = Math.max(15_000, Math.min(params.timeoutMs ?? 120_000, 180_000));
    this.activeReportStepRunsByRun.get(params.runId)?.add(params.stepRunId);

    void (async () => {
      try {
        const report = await this.agentHost.runNodeReport({
          agentId: params.node.agentId,
          context: {
            runId: params.runId,
            stepRunId: params.stepRunId,
            nodeId: params.node.id,
            workspacePath: params.workspacePath,
            stepDir: params.stepDir,
            stepLogPath: params.stepLogPath,
            goal: params.node.goal ?? "",
            settings: params.node.settings ?? {},
            plannedNode: params.nodePlan,
            resolvedInputs: params.resolvedInputs,
            env: params.env,
            reportMode: true,
            reportContext: {
              reportKind: "post_step",
              stepStatus: params.status,
              stepError: params.errorSummary ?? undefined,
              artifactTitles: params.artifactTitles,
              logTail: this.readStepLogTail(params.stepLogPath, 20),
            },
          },
          timeoutMs: reportTimeoutMs,
        });

        const content = report.trim();
        if (!content) {
          return;
        }

        this.writeNodeMessage(params.runId, params.node.id, "agent", "run", `Post-step report:\n${content}`);
      } catch (error) {
        this.logger.warn(
          { err: error, runId: params.runId, nodeId: params.node.id, stepRunId: params.stepRunId },
          "post-step report generation failed",
        );
      } finally {
        this.activeReportStepRunsByRun.get(params.runId)?.delete(params.stepRunId);
      }
    })();
  }

  private shouldRunPostStepReport(agentId: string, settings: Record<string, unknown>): boolean {
    const explicit =
      settings.postStepReport ??
      settings.enablePostStepReport ??
      settings.reportAfterStep;

    if (typeof explicit === "boolean") {
      return explicit;
    }

    return agentId === "openclaw" || agentId === "codex-cli" || agentId === "codex";
  }

  private buildOpenClawPostStepReport(input: {
    status: StepStatus;
    errorSummary: string | null;
    artifactTitles: string[];
    logTail: string[];
  }): string {
    const lines: string[] = [];
    lines.push(`Status: ${input.status}.`);
    if (input.errorSummary) {
      lines.push(`Error: ${input.errorSummary}`);
    }

    const failureSignals = input.logTail
      .filter((line) => /(browser failed|gateway closed|browser unavailable|unable to open|failed to open)/i.test(line))
      .slice(-2);
    const successSignals = input.logTail
      .filter((line) =>
        /(opened https?:\/\/|navigation (?:complete|succeeded)|page loaded|browser task completed|verified|resolved url)/i.test(
          line,
        ),
      )
      .slice(-2);
    const hasBrowserEvidenceArtifact = input.artifactTitles.some((title) => /blackboxreport/i.test(title));

    if (failureSignals.length > 0) {
      lines.push(`Browser result: failed (${failureSignals[failureSignals.length - 1]}).`);
    } else if (successSignals.length > 0 || hasBrowserEvidenceArtifact) {
      const signal = successSignals[successSignals.length - 1];
      lines.push(
        signal
          ? `Browser result: success (${signal}).`
          : "Browser result: success (browser evidence found in artifacts).",
      );
    } else if (input.status === "success") {
      lines.push("Browser result: unverified (no explicit browser success/failure signals found in recent logs).");
    }

    if (input.artifactTitles.length > 0) {
      lines.push(`Artifacts: ${input.artifactTitles.join(", ")}`);
    }

    if (input.status !== "success") {
      lines.push("Action: browser task was not completed successfully.");
    } else if (failureSignals.length === 0 && successSignals.length === 0 && !hasBrowserEvidenceArtifact) {
      lines.push("Action: browser outcome is unverified; check step logs or rerun with stricter browser-only instructions.");
    }

    return lines.join("\n");
  }

  private appendStepLogLine(stepLogPath: string, stream: "stdout" | "stderr", line: string): void {
    try {
      fs.appendFileSync(stepLogPath, `[${stream}] ${line}\n`, "utf8");
    } catch {
      // ignore logging failures for loop control-only steps
    }
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

  private extractOpenClawPayloadTextFromLog(stepLogPath: string): string | null {
    try {
      if (!fs.existsSync(stepLogPath)) {
        return null;
      }

      const raw = fs.readFileSync(stepLogPath, "utf8");
      if (!raw.trim()) {
        return null;
      }

      const stripAnsi = (input: string): string => input.replace(/\x1B\[[0-9;]*m/g, "");
      const normalized = raw
        .split(/\r?\n/)
        .map((line) => line.replace(/^\[(stdout|stderr)\]\s?/i, ""))
        .map(stripAnsi)
        .join("\n");

      let capturing = false;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let jsonBuffer = "";
      const payloadTexts: string[] = [];

      const pushPayloadTexts = (jsonText: string): void => {
        try {
          const parsed = JSON.parse(jsonText) as { payloads?: unknown };
          if (!Array.isArray(parsed.payloads)) {
            return;
          }
          for (const item of parsed.payloads) {
            if (!item || typeof item !== "object") {
              continue;
            }
            const text = (item as { text?: unknown }).text;
            if (typeof text === "string" && text.trim()) {
              payloadTexts.push(text.trim());
            }
          }
        } catch {
          // ignore malformed payload block
        }
      };

      for (const char of `${normalized}\n`) {
        if (!capturing) {
          if (char !== "{") {
            continue;
          }
          capturing = true;
          depth = 1;
          inString = false;
          escaped = false;
          jsonBuffer = "{";
          continue;
        }

        jsonBuffer += char;

        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (char === "\\") {
            escaped = true;
            continue;
          }
          if (char === "\"") {
            inString = false;
          }
          continue;
        }

        if (char === "\"") {
          inString = true;
          continue;
        }
        if (char === "{") {
          depth += 1;
          continue;
        }
        if (char === "}") {
          depth -= 1;
          if (depth !== 0) {
            continue;
          }
          pushPayloadTexts(jsonBuffer);
          capturing = false;
          depth = 0;
          inString = false;
          escaped = false;
          jsonBuffer = "";
        }
      }

      const last = payloadTexts.at(-1)?.trim();
      return last || null;
    } catch {
      return null;
    }
  }

  private readLastStepError(stepLogPath: string): string | null {
    try {
      if (!fs.existsSync(stepLogPath)) {
        return null;
      }
      const lines = fs.readFileSync(stepLogPath, "utf8").split(/\r?\n/).filter(Boolean);
      const cleaned = lines
        .filter((line) => line.includes("[stderr]"))
        .map((line) => line.replace(/^\[stderr\]\s?/, "").trim())
        .filter(Boolean);
      if (cleaned.length === 0) {
        return null;
      }

      for (let i = cleaned.length - 1; i >= 0; i -= 1) {
        const line = cleaned[i];
        if (/(^|\s)(error|failed|exception)\b/i.test(line)) {
          return line;
        }
      }

      for (let i = cleaned.length - 1; i >= 0; i -= 1) {
        const line = cleaned[i];
        if (!/^Docs:/i.test(line) && !/^Usage:/i.test(line)) {
          return line;
        }
      }

      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line.includes("[stderr]")) {
          continue;
        }
        return line.replace(/^\[stderr\]\s?/, "").trim() || null;
      }
      return null;
    } catch {
      return null;
    }
  }

  private isUrlLikeType(type: string): boolean {
    const normalized = type.trim().toLowerCase();
    return normalized === "url" || normalized.endsWith("_url") || normalized.endsWith("url");
  }

  private extractUrlsFromArtifact(artifact: ArtifactRecord): string[] {
    const urls: string[] = [];
    const seen = new Set<string>();
    const push = (value: string | null): void => {
      if (!value || seen.has(value)) {
        return;
      }
      seen.add(value);
      urls.push(value);
    };

    if (artifact.meta_json) {
      try {
        const meta = JSON.parse(artifact.meta_json) as { url?: unknown; urls?: unknown };
        if (Array.isArray(meta.urls)) {
          for (const item of meta.urls) {
            if (typeof item !== "string") {
              continue;
            }
            push(normalizeUrlCandidate(item));
          }
        }
        if (typeof meta.url === "string") {
          push(normalizeUrlCandidate(meta.url));
        }
      } catch {
        // ignore malformed metadata
      }
    }

    const normalizedPath = normalizeUrlCandidate(artifact.path);
    push(normalizedPath);

    const rawPath = artifact.path.trim();
    if (fs.existsSync(rawPath)) {
      try {
        const content = fs.readFileSync(rawPath, "utf8");
        const extracted = extractUrlsFromText(content);
        for (const item of extracted) {
          push(item);
        }
      } catch {
        // ignore read errors
      }
    }

    return urls;
  }

  private async preflightResolvedUrls(nodeId: string, resolvedInputs: ResolvedInputs): Promise<string | null> {
    const urls = new Set<string>();

    for (const [inputType, artifacts] of Object.entries(resolvedInputs.inputsByType)) {
      if (!this.isUrlLikeType(inputType)) {
        continue;
      }
      for (const artifact of artifacts) {
        for (const url of this.extractUrlsFromArtifact(artifact)) {
          urls.add(url);
        }
      }
    }

    this.logger.info(
      { nodeId, urlCount: urls.size, urls: [...urls] },
      "preflight URL validation disabled: passing through all resolved handoff URLs",
    );

    return null;
  }

  private async checkUrlReachability(url: string): Promise<{ ok: boolean; reason: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const normalized = normalizeUrlCandidate(url);

    if (!normalized) {
      return { ok: false, reason: `Failed to parse URL from ${url}` };
    }

    try {
      const response = await fetch(normalized, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      return { ok: true, reason: `reachable (status ${response.status})` };
    } catch (error) {
      const err = error as { message?: string; cause?: { code?: string }; code?: string; name?: string };
      const code = err.code ?? err.cause?.code;
      const message = err.message ?? String(error);
      if (code === "ECONNREFUSED" || /connection refused|econnrefused/i.test(message)) {
        return { ok: false, reason: `connection refused for ${normalized}` };
      }
      if (err.name === "AbortError") {
        return { ok: false, reason: `timeout while connecting to ${normalized}` };
      }
      return { ok: false, reason: `${message} (${normalized})` };
    } finally {
      clearTimeout(timeout);
    }
  }

  private isLocalRuntimeUrl(url: string): boolean {
    const normalized = normalizeUrlCandidate(url);
    if (!normalized) {
      return false;
    }
    try {
      const parsed = new URL(normalized);
      const hostname = parsed.hostname.trim().toLowerCase();
      return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch {
      return false;
    }
  }

  private isLikelyPreflightTargetUrl(url: string): boolean {
    const normalized = normalizeUrlCandidate(url);
    if (!normalized) {
      return false;
    }

    try {
      const parsed = new URL(normalized);
      return !this.isLikelyAssetUrl(parsed);
    } catch {
      return false;
    }
  }

  private isLikelyAssetUrl(parsed: URL): boolean {
    const hostname = parsed.hostname.trim().toLowerCase();
    const pathname = parsed.pathname.trim().toLowerCase();

    if (hostname === "fonts.googleapis.com" || hostname === "fonts.gstatic.com" || hostname.endsWith(".gstatic.com")) {
      return true;
    }

    if (hostname.includes("googleapis.com") && pathname.includes("/css2")) {
      return true;
    }

    return /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|eot|webp|avif)$/i.test(pathname);
  }

  private resolveStepMaxAttempts(agentId: string, settings: Record<string, unknown>): number {
    const numericCandidates = [settings.maxAttempts, settings.retryAttempts, settings.selfHealAttempts];
    for (const candidate of numericCandidates) {
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return Math.max(1, Math.min(GraphExecutor.MAX_SELF_HEAL_ATTEMPTS, Math.floor(candidate)));
      }
      if (typeof candidate === "string") {
        const parsed = Number(candidate);
        if (Number.isFinite(parsed)) {
          return Math.max(1, Math.min(GraphExecutor.MAX_SELF_HEAL_ATTEMPTS, Math.floor(parsed)));
        }
      }
    }

    if (settings.selfHealing === false || settings.retryOnFailure === false) {
      return 1;
    }

    if (agentId === "openclaw" || agentId === "codex-cli" || agentId === "codex") {
      return GraphExecutor.DEFAULT_SELF_HEAL_ATTEMPTS_FOR_LLM;
    }

    return GraphExecutor.DEFAULT_SELF_HEAL_ATTEMPTS;
  }

  private extractExpectedOutputFiles(goal: string): string[] {
    const expected = new Set<string>();
    const lines = goal.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const lowered = line.toLowerCase();
      if (!/(save|write|export|create|output)/.test(lowered)) {
        continue;
      }

      const matches = line.match(/(?:\.{1,2}\/)[^\s`"'<>|]+/g) ?? [];
      for (const match of matches) {
        const normalized = match.replace(/[),.;:!?]+$/g, "").trim();
        if (!normalized) {
          continue;
        }
        if (!/\.[A-Za-z0-9]{1,10}$/.test(normalized)) {
          continue;
        }
        expected.add(normalized);
      }
    }

    return [...expected];
  }

  private findMissingExpectedOutputFiles(workspacePath: string, expectedFiles: string[]): string[] {
    if (expectedFiles.length === 0) {
      return [];
    }

    const missing: string[] = [];
    for (const expectedFile of expectedFiles) {
      const fullPath = path.resolve(workspacePath, expectedFile);
      if (!fs.existsSync(fullPath)) {
        missing.push(expectedFile);
      }
    }
    return missing;
  }

  private buildAttemptGoal(baseGoal: string, attempt: number, maxAttempts: number, previousError: string | null): string {
    if (attempt === 1) {
      return baseGoal;
    }

    const retryContext = [
      "",
      `Retry attempt ${attempt}/${maxAttempts}.`,
      "Self-heal instruction: analyze previous failure and apply a corrected approach.",
      previousError ? `Previous error: ${previousError}` : "Previous error: unknown",
      "Do not repeat the same failing command unchanged.",
    ].join("\n");

    return `${baseGoal}${retryContext}`;
  }

  private resolveLoopDelaySeconds(settings: Record<string, unknown>): number {
    const raw = settings.delaySeconds;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return 10;
    }
    return Math.max(0, Math.floor(raw));
  }

  private resolveLoopCarryContext(settings: Record<string, unknown>): boolean {
    const raw = settings.carryContext;
    return typeof raw === "boolean" ? raw : true;
  }
}
