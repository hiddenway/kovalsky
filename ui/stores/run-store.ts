import { create } from "zustand";
import { getApiClient } from "@/lib/api/client";
import { readRunsFromStorage, writeRunsToStorage } from "@/lib/run-storage";
import type { Artifact, Pipeline, RunRecord, RunStatus, StepRun, StepStatus } from "@/lib/types";
import { usePipelineStore } from "@/stores/pipeline-store";

const POLL_INTERVAL_MS = 1200;
const FINAL_STATUSES: RunStatus[] = ["success", "failed", "canceled"];

const controllers = new Map<string, { canceled: boolean }>();

function persist(records: RunRecord[]): void {
  writeRunsToStorage(records);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function toStepStatus(status: string): StepStatus {
  if (status === "running" || status === "success" || status === "failed" || status === "skipped" || status === "canceled") {
    return status;
  }
  return "pending";
}

function toRunStatus(status: string): RunStatus {
  if (status === "running" || status === "success" || status === "failed" || status === "canceled") {
    return status;
  }
  return "queued";
}

function stepStatusMap(steps: StepRun[]): Record<string, StepStatus> {
  return steps.reduce<Record<string, StepStatus>>((acc, step) => {
    acc[step.stepId] = step.status;
    return acc;
  }, {});
}

function parseMetaJson(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

type NodeChatMessage = {
  id: string;
  run_id: string;
  node_id: string;
  role: "user" | "agent" | "system";
  phase: "pre_run" | "run";
  content: string;
  created_at: string;
  meta_json: string | null;
};

function looksLikeAwaitingUserInputText(content: string): boolean {
  const normalized = content.trim().toLowerCase();
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

function isAwaitingUserInputFromChat(messages: NodeChatMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "agent" || message.phase !== "run") {
      continue;
    }

    const meta = parseMetaJson(message.meta_json);
    const source = typeof meta?.source === "string" ? meta.source.trim().toLowerCase() : "";
    if (source && source !== "chat_followup_report") {
      continue;
    }

    const rerunDecision = typeof meta?.rerunDecision === "string" ? meta.rerunDecision.trim().toLowerCase() : "";
    if (rerunDecision === "rerun") {
      return false;
    }
    if (meta?.awaitingUserInput === true) {
      return true;
    }
    return looksLikeAwaitingUserInputText(message.content);
  }

  return false;
}

async function mapSnapshotToRecord(
  runId: string,
  pipelineSnapshot: Pipeline,
  previous: RunRecord | null,
): Promise<RunRecord | null> {
  const api = getApiClient();
  const snapshot = await api.getRun(runId);

  if (!snapshot?.run) {
    return null;
  }

  const previousByStepId = new Map(previous?.steps.map((step) => [step.stepId, step]) ?? []);
  const previewCache = new Map(
    previous?.steps.flatMap((step) => step.artifacts.map((artifact) => [artifact.id, artifact] as const)) ?? [],
  );

  const stepRunsByNodeId = new Map<string, typeof snapshot.stepRuns>();
  for (const stepRun of snapshot.stepRuns) {
    const bucket = stepRunsByNodeId.get(stepRun.node_id) ?? [];
    bucket.push(stepRun);
    stepRunsByNodeId.set(stepRun.node_id, bucket);
  }

  const latestStepRuns = [...stepRunsByNodeId.values()].map((group) =>
    group
      .slice()
      .sort((left, right) => {
        const leftAt = left.started_at ?? left.finished_at ?? "";
        const rightAt = right.started_at ?? right.finished_at ?? "";
        if (leftAt === rightAt) {
          return left.id.localeCompare(right.id);
        }
        return leftAt.localeCompare(rightAt);
      })[group.length - 1],
  );

  const steps = await Promise.all(
    latestStepRuns.map(async (stepRun) => {
      const stepId = stepRun.node_id;
      const previousStep = previousByStepId.get(stepId);
      const sameNodeRuns = stepRunsByNodeId.get(stepId) ?? [];
      const rerunCount = Math.max(0, sameNodeRuns.length - 1);
      const isRerun = rerunCount > 0;

      const logs = await api
        .getStepLogs(runId, stepRun.id, 120)
        .then((result) => result.lines)
        .catch(() => previousStep?.logs ?? []);

      const artifacts = await Promise.all(
        snapshot.artifacts
          .filter((artifact) => artifact.produced_by_step_run_id === stepRun.id && artifact.type !== "BlackboxReport")
          .map(async (artifact) => {
            const cached = previewCache.get(artifact.id);
            const parsedMeta = parseMetaJson(artifact.meta_json);

            if (cached?.preview) {
              return {
                ...cached,
                type: artifact.type,
                title: artifact.title,
                mime: artifact.mime,
                createdAt: artifact.created_at,
                details: cached.details ?? parsedMeta,
              };
            }

            const preview = await api
              .getArtifactPreview(artifact.id)
              .catch(() => null);

            return {
              id: artifact.id,
              type: artifact.type,
              title: artifact.title,
              mime: artifact.mime,
              createdAt: artifact.created_at,
              preview: preview?.preview,
              details: preview?.meta ?? parsedMeta,
            } satisfies Artifact;
          }),
      );

      const status = toStepStatus(stepRun.status);
      let awaitingUserInput = false;
      if (status === "pending") {
        if (previousStep?.awaitingUserInput) {
          awaitingUserInput = true;
        } else {
          awaitingUserInput = await api
            .getNodeChat(runId, stepId)
            .then((payload) => isAwaitingUserInputFromChat(payload.messages))
            .catch(() => false);
        }
      }
      return {
        stepId,
        agentId: stepRun.agent_id,
        status,
        awaitingUserInput,
        rerun: isRerun,
        rerunCount,
        logs,
        artifacts,
        summary:
          stepRun.error_summary ??
          (status === "success"
            ? "Completed successfully"
            : status === "failed"
              ? "Execution failed"
              : status === "running"
                ? "Executing"
                : status === "canceled"
                  ? "Canceled"
                  : awaitingUserInput
                    ? "Awaiting your reply in chat"
                    : "Waiting"),
      } satisfies StepRun;
    }),
  );

  return {
    run: {
      id: snapshot.run.id,
      pipelineId: snapshot.run.pipeline_id,
      status: toRunStatus(snapshot.run.status),
      startedAt: snapshot.run.started_at ?? new Date().toISOString(),
      finishedAt: snapshot.run.finished_at ?? undefined,
    },
    pipelineSnapshot,
    steps,
  };
}

type RunState = {
  hydrated: boolean;
  records: RunRecord[];
  activeRunId: string | null;
  init: () => void;
  startRun: (pipeline: Pipeline) => Promise<string>;
  attachExternalRun: (runId: string, pipeline: Pipeline) => void;
  cancelRun: (runId: string) => void;
  cancelRunsForPipeline: (pipelineId: string) => Promise<number>;
  retryFailedSteps: (runId: string) => Promise<string | null>;
  getRun: (runId: string) => RunRecord | null;
};

export const useRunStore = create<RunState>((set, get) => ({
  hydrated: false,
  records: [],
  activeRunId: null,
  init: () => {
    if (get().hydrated) {
      return;
    }

    const loaded = readRunsFromStorage().map((record) => ({
      ...record,
      steps: record.steps.map((step) => ({
        ...step,
        artifacts: step.artifacts.filter((artifact) => artifact.type !== "BlackboxReport"),
      })),
    }));
    set({
      hydrated: true,
      records: loaded,
      activeRunId: loaded[0]?.run.id ?? null,
    });

    const inFlight = loaded.filter((record) => record.run.status === "queued" || record.run.status === "running");
    if (inFlight.length === 0) {
      return;
    }

    const preferredActiveRunId = loaded[0]?.run.id ?? null;
    for (const record of inFlight) {
      get().attachExternalRun(record.run.id, record.pipelineSnapshot);
    }

    if (preferredActiveRunId) {
      set((state) => ({
        activeRunId: state.records.some((record) => record.run.id === preferredActiveRunId)
          ? preferredActiveRunId
          : state.activeRunId,
      }));
    }
  },
  startRun: async (pipeline) => {
    if (pipeline.nodes.length === 0) {
      throw new Error("Workflow has no nodes");
    }

    const api = getApiClient();
    const provisionalRunId = `pending-${crypto.randomUUID()}`;
    const initialSteps: StepRun[] = pipeline.nodes.map((node) => ({
      stepId: node.id,
      agentId: node.data.agentId,
      status: "pending",
      logs: [],
      artifacts: [],
      summary: "Waiting",
    }));

    const provisionalRecord: RunRecord = {
      run: {
        id: provisionalRunId,
        pipelineId: pipeline.id,
        status: "queued",
        startedAt: new Date().toISOString(),
      },
      pipelineSnapshot: pipeline,
      steps: initialSteps,
    };

    set((state) => {
      const records = [provisionalRecord, ...state.records].slice(0, 80);
      persist(records);
      return {
        records,
        activeRunId: provisionalRunId,
      };
    });
    usePipelineStore.getState().applyStepStatuses(stepStatusMap(initialSteps));

    let runId = provisionalRunId;
    try {
      let pipelineId = pipeline.id;
      try {
        await api.updatePipeline(pipeline);
      } catch {
        const created = await api.createPipeline(pipeline);
        pipelineId = created.pipelineId;
      }

      const started = await api.createRun({
        pipelineId,
        overrides: pipeline.workspacePath?.trim()
          ? {
              workspacePath: pipeline.workspacePath.trim(),
              clearNodeChatContext: pipeline.clearNodeChatContextOnRun ?? false,
            }
          : undefined,
      });
      runId = started.runId;

      controllers.set(runId, { canceled: false });

      set((state) => {
        const records = state.records.map((record) =>
          record.run.id === provisionalRunId
            ? {
                ...record,
                run: {
                  ...record.run,
                  id: runId,
                  pipelineId,
                },
              }
            : record,
        );
        persist(records);
        return {
          records,
          activeRunId: state.activeRunId === provisionalRunId ? runId : state.activeRunId,
        };
      });
    } catch (error) {
      set((state) => {
        const records = state.records.map((record) =>
          record.run.id === provisionalRunId
            ? {
                ...record,
                run: {
                  ...record.run,
                  status: "failed" as RunStatus,
                  finishedAt: new Date().toISOString(),
                },
                steps: record.steps.map((step) => ({
                  ...step,
                  status: "failed" as StepStatus,
                  summary: error instanceof Error ? error.message : "Failed to start run",
                })),
              }
            : record,
        );
        persist(records);
        return { records };
      });
      usePipelineStore.getState().clearStepStatuses();
      throw error;
    }

    void (async () => {
      try {
        const controller = controllers.get(runId);
        while (true) {
          if (controller?.canceled) {
            await api.cancelRun(runId).catch(() => {
              return;
            });
          }

          const current = get().records.find((record) => record.run.id === runId) ?? null;
          const next = await mapSnapshotToRecord(runId, pipeline, current);
          if (!next) {
            break;
          }

          set((state) => {
            const records = state.records.map((record) => (record.run.id === runId ? next : record));
            persist(records);
            return { records };
          });
          usePipelineStore.getState().applyStepStatuses(stepStatusMap(next.steps));

          if (FINAL_STATUSES.includes(next.run.status)) {
            break;
          }

          await sleep(POLL_INTERVAL_MS);
        }
      } finally {
        controllers.delete(runId);
      }
    })();

    return runId;
  },
  attachExternalRun: (runId, pipeline) => {
    if (!runId.trim()) {
      return;
    }

    const existing = get().records.find((item) => item.run.id === runId);
    if (!existing) {
      const initialSteps: StepRun[] = pipeline.nodes.map((node) => ({
        stepId: node.id,
        agentId: node.data.agentId,
        status: "pending",
        logs: [],
        artifacts: [],
        summary: "Waiting",
      }));

      const provisional: RunRecord = {
        run: {
          id: runId,
          pipelineId: pipeline.id,
          status: "queued",
          startedAt: new Date().toISOString(),
        },
        pipelineSnapshot: pipeline,
        steps: initialSteps,
      };

      set((state) => {
        const records = [provisional, ...state.records].slice(0, 80);
        persist(records);
        return {
          records,
          activeRunId: runId,
        };
      });
      usePipelineStore.getState().applyStepStatuses(stepStatusMap(initialSteps));
    } else {
      set((state) => ({
        ...state,
        activeRunId: runId,
      }));
    }

    if (!controllers.has(runId)) {
      controllers.set(runId, { canceled: false });
    }

    void (async () => {
      try {
        const api = getApiClient();
        const controller = controllers.get(runId);
        while (true) {
          if (controller?.canceled) {
            await api.cancelRun(runId).catch(() => {
              return;
            });
          }

          const current = get().records.find((record) => record.run.id === runId) ?? null;
          const next = await mapSnapshotToRecord(runId, pipeline, current);
          if (!next) {
            break;
          }

          set((state) => {
            const records = state.records.some((record) => record.run.id === runId)
              ? state.records.map((record) => (record.run.id === runId ? next : record))
              : [next, ...state.records].slice(0, 80);
            persist(records);
            return {
              records,
              activeRunId: runId,
            };
          });
          usePipelineStore.getState().applyStepStatuses(stepStatusMap(next.steps));

          if (FINAL_STATUSES.includes(next.run.status)) {
            break;
          }

          await sleep(POLL_INTERVAL_MS);
        }
      } finally {
        controllers.delete(runId);
      }
    })();
  },
  cancelRun: (runId) => {
    const controller = controllers.get(runId);
    if (controller) {
      controller.canceled = true;
    }

    void getApiClient().cancelRun(runId).catch(() => {
      return;
    });

    set((state) => {
      const records = state.records.map((record) =>
        record.run.id === runId
          ? {
              ...record,
              run: {
                ...record.run,
                status: "canceled" as RunStatus,
                finishedAt: new Date().toISOString(),
              },
              steps: record.steps.map((step) =>
                step.status === "pending" || step.status === "running"
                  ? {
                      ...step,
                      status: "canceled" as StepStatus,
                      summary: "Canceled",
                    }
                  : step,
              ),
            }
          : record,
      );
      persist(records);
      return { records };
    });
  },
  cancelRunsForPipeline: async (pipelineId) => {
    const targets = get().records
      .filter((record) => record.pipelineSnapshot.id === pipelineId)
      .filter((record) => record.run.status === "queued" || record.run.status === "running")
      .map((record) => record.run.id);

    for (const runId of targets) {
      get().cancelRun(runId);
    }

    return targets.length;
  },
  retryFailedSteps: async (runId) => {
    const record = get().records.find((item) => item.run.id === runId);
    if (!record) {
      return null;
    }

    return get().startRun(record.pipelineSnapshot);
  },
  getRun: (runId) => {
    return get().records.find((record) => record.run.id === runId) ?? null;
  },
}));
