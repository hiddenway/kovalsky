"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { getApiClient } from "@/lib/api/client";
import type { TriggerListItem } from "@/lib/api/contracts";
import type { RunRecord, StepRun } from "@/lib/types";
import { useRunStore } from "@/stores/run-store";

type StepWithMeta = {
  step: StepRun;
  statusLabel: string;
  goal: string;
  nodeTitle: string;
};

function getStepStatusLabel(step: StepRun, loopWaiting: boolean): string {
  if (loopWaiting && step.agentId === "loop" && step.status === "success" && step.logs.some((line) => /loop status:\s*waiting/i.test(line))) {
    return "waiting";
  }
  if (step.awaitingUserInput && step.status === "pending") {
    return "awaiting";
  }
  return step.status;
}

function buildStepsWithMeta(record: RunRecord): StepWithMeta[] {
  return record.steps.map((step) => {
    const node = record.pipelineSnapshot.nodes.find((item) => item.id === step.stepId);
    const goal = node?.data.goal?.trim() ?? "";
    const customName = node?.data.customName?.trim() ?? "";
    return {
      step,
      statusLabel: getStepStatusLabel(step, record.run.loopWaiting === true),
      goal,
      nodeTitle: customName || step.agentId,
    };
  });
}

function statusClass(status: string): string {
  if (status === "running" || status === "waiting" || status === "awaiting") {
    return "border-amber-700/60 bg-amber-950 text-amber-300";
  }
  if (status === "success") {
    return "border-emerald-700/60 bg-emerald-950 text-emerald-300";
  }
  if (status === "failed") {
    return "border-rose-700/60 bg-rose-950 text-rose-300";
  }
  if (status === "canceled") {
    return "border-zinc-700 bg-zinc-900 text-zinc-400";
  }
  return "border-zinc-700 bg-zinc-800 text-zinc-300";
}

function triggerStatusClass(status: TriggerListItem["status"]): string {
  if (status === "active" || status === "working") {
    return "border-amber-700/60 bg-amber-950 text-amber-300";
  }
  if (status === "paused") {
    return "border-zinc-700 bg-zinc-900 text-zinc-300";
  }
  return "border-zinc-700 bg-zinc-900 text-zinc-500";
}

export function RunsPage(): React.JSX.Element {
  const hydrated = useRunStore((state) => state.hydrated);
  const records = useRunStore((state) => state.records);
  const init = useRunStore((state) => state.init);
  const cancelRun = useRunStore((state) => state.cancelRun);
  const [openLogsByRun, setOpenLogsByRun] = useState<Record<string, string | null>>({});
  const [triggers, setTriggers] = useState<TriggerListItem[]>([]);
  const [triggersLoading, setTriggersLoading] = useState(false);
  const [triggersError, setTriggersError] = useState("");
  const [stoppingTriggerKey, setStoppingTriggerKey] = useState("");

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    let disposed = false;
    const api = getApiClient();

    const loadTriggers = async (silent = false): Promise<void> => {
      if (!silent) {
        setTriggersLoading(true);
      }
      try {
        const payload = await api.listTriggers();
        if (disposed) {
          return;
        }
        setTriggers(payload.triggers);
        setTriggersError("");
      } catch (error) {
        if (disposed) {
          return;
        }
        if (!silent) {
          setTriggers([]);
        }
        setTriggersError(error instanceof Error ? error.message : "Failed to load triggers");
      } finally {
        if (!disposed && !silent) {
          setTriggersLoading(false);
        }
      }
    };

    void loadTriggers();
    const interval = window.setInterval(() => {
      void loadTriggers(true);
    }, 2000);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  const sorted = useMemo(
    () =>
      records
        .slice()
        .sort((left, right) => right.run.startedAt.localeCompare(left.run.startedAt)),
    [records],
  );
  const activeTriggers = useMemo(
    () => triggers.filter((trigger) => trigger.status === "active" || trigger.status === "working"),
    [triggers],
  );

  if (!hydrated) {
    return <div className="flex h-screen items-center justify-center text-zinc-400">Loading runs...</div>;
  }

  return (
    <div className="min-h-screen bg-zinc-950 px-6 py-6 text-zinc-100">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Runs</h1>
            <p className="text-sm text-zinc-400">All pipeline executions</p>
          </div>

          <div className="flex gap-2">
            <Link href="/pipelines" className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Pipelines
            </Link>
            <Link href="/settings" className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Settings
            </Link>
            <Link href="/builder" className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Builder
            </Link>
          </div>
        </div>

        <section className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Triggers</h2>
              <p className="text-xs text-zinc-400">
                Total: {triggers.length} | Active: {activeTriggers.length}
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={async () => {
                setTriggersLoading(true);
                setTriggersError("");
                try {
                  const payload = await getApiClient().listTriggers();
                  setTriggers(payload.triggers);
                } catch (error) {
                  setTriggersError(error instanceof Error ? error.message : "Failed to load triggers");
                } finally {
                  setTriggersLoading(false);
                }
              }}
            >
              Refresh
            </Button>
          </div>

          {triggersLoading ? (
            <p className="mt-3 text-sm text-zinc-400">Loading triggers...</p>
          ) : triggersError ? (
            <p className="mt-3 text-sm text-rose-300">{triggersError}</p>
          ) : triggers.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">No triggers configured.</p>
          ) : (
            <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
              {triggers.map((trigger) => {
                const triggerKey = `${trigger.pipelineId}:${trigger.nodeId}`;
                const canStop = trigger.status === "active" || trigger.status === "working";
                const isStopping = stoppingTriggerKey === triggerKey;
                return (
                  <article key={triggerKey} className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{trigger.pipelineName}</p>
                      <span
                        className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${triggerStatusClass(trigger.status)}`}
                      >
                        {trigger.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-400">
                      Pipeline: {trigger.pipelineId} | Node: {trigger.nodeId} | Type: {trigger.configType ?? "unknown"}
                    </p>
                    <p className="mt-1 line-clamp-2 text-xs text-zinc-300">{trigger.goal || "Goal is empty"}</p>
                    {trigger.lastError ? (
                      <p className="mt-1 line-clamp-2 text-xs text-rose-300">Last error: {trigger.lastError}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-zinc-500">
                      Last check: {trigger.lastCheckAt ? new Date(trigger.lastCheckAt).toLocaleString() : "—"}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Link
                        href={`/builder?pipelineId=${trigger.pipelineId}`}
                        className="rounded-md border border-cyan-400/50 bg-cyan-500/20 px-3 py-1.5 text-sm text-cyan-100 hover:bg-cyan-500/30"
                      >
                        Open
                      </Link>
                      <Button
                        type="button"
                        variant="danger"
                        disabled={!canStop || isStopping}
                        onClick={async () => {
                          setStoppingTriggerKey(triggerKey);
                          try {
                            await getApiClient().pauseTrigger({
                              pipelineId: trigger.pipelineId,
                              nodeId: trigger.nodeId,
                            });
                            const payload = await getApiClient().listTriggers();
                            setTriggers(payload.triggers);
                            setTriggersError("");
                          } catch (error) {
                            setTriggersError(error instanceof Error ? error.message : "Failed to stop trigger");
                          } finally {
                            setStoppingTriggerKey("");
                          }
                        }}
                      >
                        {isStopping ? "Stopping..." : "Stop"}
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {sorted.length === 0 ? (
          <div className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 text-sm text-zinc-400">No runs yet.</div>
        ) : (
          <div className="mt-5 space-y-3">
            {sorted.map((record) => {
              const steps = buildStepsWithMeta(record);
              const runningNow = steps.filter((item) =>
                item.statusLabel === "running" || item.statusLabel === "waiting" || item.statusLabel === "awaiting",
              );
              const startedHistory = steps
                .filter((item) =>
                  Boolean(item.step.startedAt)
                  || item.step.status !== "pending"
                  || item.step.logs.length > 0
                  || item.step.artifacts.length > 0
                  || item.statusLabel === "awaiting"
                  || item.statusLabel === "waiting",
                )
                .sort((left, right) => {
                  const leftAt = left.step.startedAt ?? left.step.finishedAt ?? "";
                  const rightAt = right.step.startedAt ?? right.step.finishedAt ?? "";
                  if (leftAt === rightAt) {
                    return left.step.stepId.localeCompare(right.step.stepId);
                  }
                  return rightAt.localeCompare(leftAt);
                });
              const runIsActive = record.run.status === "queued" || record.run.status === "running" || record.run.loopWaiting === true;
              const runStatusLabel = runIsActive && runningNow.length > 0 ? "running" : record.run.status;
              const isCancelable = runIsActive;
              const openStepId = openLogsByRun[record.run.id] ?? null;
              const selectedStep = steps.find((item) => item.step.stepId === openStepId) ?? null;
              return (
                <article key={record.run.id} className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold">{record.pipelineSnapshot.name}</h2>
                      <p className="mt-1 truncate text-xs text-zinc-400">Run ID: {record.run.id}</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        Status: {runStatusLabel} | Started: {new Date(record.run.startedAt).toLocaleString()}
                        {record.run.finishedAt ? ` | Finished: ${new Date(record.run.finishedAt).toLocaleString()}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-zinc-500">
                        Running now: {runningNow.length} | Started agents: {startedHistory.length} | Pipeline ID: {record.pipelineSnapshot.id}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Link
                        href={`/runs/${record.run.id}`}
                        className="rounded-md border border-cyan-400/50 bg-cyan-500/20 px-3 py-1.5 text-sm text-cyan-100 hover:bg-cyan-500/30"
                      >
                        Open
                      </Link>
                      <Button type="button" variant="danger" onClick={() => cancelRun(record.run.id)} disabled={!isCancelable}>
                        Cancel
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs uppercase tracking-wide text-zinc-400">Running Now</p>
                        <span className="text-xs text-zinc-500">{runningNow.length}</span>
                      </div>
                      {runningNow.length === 0 ? (
                        <p className="text-xs text-zinc-500">No active agents in this run.</p>
                      ) : (
                        <div className="space-y-2">
                          {runningNow.map((item) => (
                            <div key={`active-${record.run.id}-${item.step.stepId}`} className="rounded-md border border-zinc-800 bg-zinc-950/70 p-2">
                              <div className="flex items-center justify-between gap-2">
                                <p className="truncate text-sm font-medium">{item.nodeTitle}</p>
                                <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusClass(item.statusLabel)}`}>
                                  {item.statusLabel}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-zinc-400">Agent: {item.step.agentId}</p>
                              <p className="mt-1 line-clamp-2 text-xs text-zinc-300">{item.goal || "Goal is empty"}</p>
                              <div className="mt-2">
                                <Button
                                  type="button"
                                  variant="secondary"
                                  onClick={() =>
                                    setOpenLogsByRun((current) => ({
                                      ...current,
                                      [record.run.id]: current[record.run.id] === item.step.stepId ? null : item.step.stepId,
                                    }))
                                  }
                                >
                                  {openStepId === item.step.stepId ? "Hide Logs" : "Open Logs"}
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>

                    <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs uppercase tracking-wide text-zinc-400">Agent History</p>
                        <span className="text-xs text-zinc-500">{startedHistory.length}</span>
                      </div>
                      {startedHistory.length === 0 ? (
                        <p className="text-xs text-zinc-500">No agents started yet.</p>
                      ) : (
                        <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                          {startedHistory.map((item) => (
                            <div key={`history-${record.run.id}-${item.step.stepId}`} className="rounded-md border border-zinc-800 bg-zinc-950/70 p-2">
                              <div className="flex items-center justify-between gap-2">
                                <p className="truncate text-sm font-medium">{item.nodeTitle}</p>
                                <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusClass(item.statusLabel)}`}>
                                  {item.statusLabel}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-zinc-400">Agent: {item.step.agentId}</p>
                              <p className="mt-1 line-clamp-2 text-xs text-zinc-300">{item.goal || "Goal is empty"}</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  variant="secondary"
                                  onClick={() =>
                                    setOpenLogsByRun((current) => ({
                                      ...current,
                                      [record.run.id]: current[record.run.id] === item.step.stepId ? null : item.step.stepId,
                                    }))
                                  }
                                >
                                  {openStepId === item.step.stepId ? "Hide Logs" : "Open Logs"}
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  </div>

                  {selectedStep ? (
                    <section className="mt-3 rounded-lg border border-zinc-800 bg-black/35 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold">Logs: {selectedStep.nodeTitle}</p>
                          <p className="text-xs text-zinc-400">
                            Agent: {selectedStep.step.agentId} | Step: {selectedStep.step.stepId} | Status: {selectedStep.statusLabel}
                          </p>
                          <p className="mt-1 line-clamp-2 text-xs text-zinc-300">Goal: {selectedStep.goal || "Goal is empty"}</p>
                        </div>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() =>
                            setOpenLogsByRun((current) => ({
                              ...current,
                              [record.run.id]: null,
                            }))
                          }
                        >
                          Close Logs
                        </Button>
                      </div>
                      <div className="mt-3 max-h-72 overflow-y-auto rounded border border-zinc-800 bg-black/40 p-2 font-mono text-xs text-zinc-200">
                        {selectedStep.step.logs.length > 0 ? (
                          selectedStep.step.logs.map((line, index) => <p key={`${record.run.id}-${selectedStep.step.stepId}-${index}`}>{line}</p>)
                        ) : (
                          <p className="text-zinc-500">No logs for this agent yet.</p>
                        )}
                      </div>
                    </section>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
