"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Artifact, StepRun } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { useRunStore } from "@/stores/run-store";
import { useToastStore } from "@/stores/toast-store";

type TabId = "logs" | "artifacts" | "summary";

type Props = {
  runId: string;
};

function ArtifactPreview({ artifact }: { artifact: Artifact }): React.JSX.Element {
  if (artifact.type === "SecurityReport") {
    const rows = Array.isArray(artifact.details?.rows)
      ? (artifact.details?.rows as Array<Record<string, unknown>>)
      : [];

    return (
      <div className="mt-2 overflow-x-auto rounded border border-zinc-800 bg-zinc-900/70 p-2">
        <table className="w-full text-left text-xs text-zinc-200">
          <thead className="text-zinc-400">
            <tr>
              <th className="py-1">Severity</th>
              <th className="py-1">Title</th>
              <th className="py-1">File</th>
              <th className="py-1">Line</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`sec-${index}`} className="border-t border-zinc-800">
                <td className="py-1">{String(row.severity ?? "-")}</td>
                <td className="py-1">{String(row.title ?? "-")}</td>
                <td className="py-1">{String(row.file ?? "-")}</td>
                <td className="py-1">{String(row.line ?? "-")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (artifact.type === "CodePatch") {
    return (
      <pre className="mt-2 overflow-x-auto rounded border border-zinc-800 bg-black/40 p-2 text-xs text-zinc-200">
        {artifact.preview ?? "No diff"}
      </pre>
    );
  }

  if (artifact.type === "TestReport") {
    return (
      <pre className="mt-2 overflow-x-auto rounded border border-zinc-800 bg-black/40 p-2 text-xs text-zinc-200">
        {artifact.preview ?? "No report"}
      </pre>
    );
  }

  return <p className="mt-2 text-xs text-zinc-300">{artifact.preview ?? "No preview available"}</p>;
}

export function RunDetailsPage({ runId }: Props): React.JSX.Element {
  const hydrated = useRunStore((state) => state.hydrated);
  const records = useRunStore((state) => state.records);
  const init = useRunStore((state) => state.init);
  const cancelRun = useRunStore((state) => state.cancelRun);
  const retryFailedSteps = useRunStore((state) => state.retryFailedSteps);

  const pushToast = useToastStore((state) => state.pushToast);

  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("logs");

  useEffect(() => {
    init();
  }, [init]);

  const record = useMemo(
    () => records.find((item) => item.run.id === runId) ?? null,
    [records, runId],
  );

  const effectiveStepId = useMemo(() => {
    if (!record) {
      return null;
    }

    if (selectedStepId && record.steps.some((step) => step.stepId === selectedStepId)) {
      return selectedStepId;
    }

    return record.steps[0]?.stepId ?? null;
  }, [record, selectedStepId]);

  const selectedStep: StepRun | null = useMemo(() => {
    if (!record || !effectiveStepId) {
      return null;
    }

    return record.steps.find((step) => step.stepId === effectiveStepId) ?? null;
  }, [effectiveStepId, record]);
  const nodeMetaByStepId = useMemo(() => {
    if (!record) {
      return new Map<string, { title: string; goal: string; agentId: string }>();
    }
    return new Map(
      record.pipelineSnapshot.nodes.map((node) => [
        node.id,
        {
          title: node.data.customName?.trim() || node.data.agentId,
          goal: node.data.goal?.trim() || "",
          agentId: node.data.agentId,
        },
      ]),
    );
  }, [record]);

  if (!hydrated) {
    return <div className="flex h-screen items-center justify-center text-zinc-400">Loading run...</div>;
  }

  if (!record) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-200">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-6 text-center">
          <p className="text-lg font-semibold">Run not found</p>
          <Link href="/builder" className="mt-3 inline-block text-sm text-cyan-300 hover:underline">
            Go to builder
          </Link>
        </div>
      </div>
    );
  }

  const hasLoopWaitingStep = record.steps.some((step) =>
    step.agentId === "loop"
    && step.status === "success"
    && step.logs.some((line) => /loop status:\s*waiting/i.test(line)),
  );
  const runIsActive = record.run.status === "queued" || record.run.status === "running";
  const effectiveRunStatus = runIsActive && hasLoopWaitingStep ? "running" : record.run.status;
  const isCancelable = runIsActive;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="border-b border-zinc-800 bg-zinc-900/70 px-6 py-4">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs text-zinc-400">Run ID: {record.run.id}</p>
            <h1 className="text-xl font-semibold">Status: {effectiveRunStatus}</h1>
            <p className="text-xs text-zinc-400">
              Started {new Date(record.run.startedAt).toLocaleString()}
              {record.run.finishedAt ? ` | Finished ${new Date(record.run.finishedAt).toLocaleString()}` : ""}
            </p>
          </div>

          <div className="flex gap-2">
            <Link href="/settings" className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Settings
            </Link>
            <Link href="/builder" className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Builder
            </Link>
            {isCancelable ? (
              <Button type="button" variant="danger" onClick={() => cancelRun(record.run.id)}>
                Cancel
              </Button>
            ) : null}
            {record.run.status === "failed" ? (
              <Button
                type="button"
                onClick={() => {
                  void retryFailedSteps(record.run.id).then((newRunId) => {
                    if (newRunId) {
                      pushToast({
                        title: "Retry started",
                        description: `New run: ${newRunId}`,
                        tone: "success",
                      });
                    }
                  });
                }}
              >
                Retry Failed Steps
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl grid-cols-[280px_1fr] gap-4 px-6 py-4">
        <aside className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
          <p className="text-xs uppercase tracking-wide text-zinc-400">Step Timeline</p>
          <ul className="mt-2 space-y-1">
            {record.steps.map((step) => (
              <li key={step.stepId}>
                <button
                  type="button"
                  onClick={() => setSelectedStepId(step.stepId)}
                  className={`w-full rounded-md border px-2 py-2 text-left text-sm transition ${
                      effectiveStepId === step.stepId
                      ? "border-cyan-400/50 bg-cyan-500/10"
                      : "border-zinc-800 bg-zinc-900 hover:bg-zinc-800"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{nodeMetaByStepId.get(step.stepId)?.title ?? step.stepId}</span>
                    <span className="text-xs text-zinc-400">{step.status}</span>
                  </div>
                  <p className="mt-1 line-clamp-1 text-xs text-zinc-500">
                    Agent: {nodeMetaByStepId.get(step.stepId)?.agentId ?? step.agentId}
                  </p>
                  <p className="mt-1 line-clamp-1 text-xs text-zinc-500">{nodeMetaByStepId.get(step.stepId)?.goal || "Goal is empty"}</p>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
          <div className="flex gap-2 border-b border-zinc-800 pb-2">
            {(["logs", "artifacts", "summary"] as TabId[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTab(item)}
                className={`rounded px-2 py-1 text-sm capitalize ${
                  tab === item ? "bg-cyan-500/20 text-cyan-200" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {item}
              </button>
            ))}
          </div>

          {selectedStep ? (
            <div className="mt-3">
              <div className="mb-3 rounded border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-300">
                <p>Agent: {nodeMetaByStepId.get(selectedStep.stepId)?.agentId ?? selectedStep.agentId}</p>
                <p className="mt-1">Goal: {nodeMetaByStepId.get(selectedStep.stepId)?.goal || "Goal is empty"}</p>
              </div>
              {tab === "logs" ? (
                <div className="h-[480px] overflow-y-auto rounded border border-zinc-800 bg-black/40 p-2 font-mono text-xs text-zinc-200">
                  {selectedStep.logs.length > 0 ? (
                    selectedStep.logs.map((line, index) => <p key={`${line}-${index}`}>{line}</p>)
                  ) : (
                    <p className="text-zinc-500">No logs for this step.</p>
                  )}
                </div>
              ) : null}

              {tab === "artifacts" ? (
                <div className="space-y-3">
                  {selectedStep.artifacts.length > 0 ? (
                    selectedStep.artifacts.map((artifact) => (
                      <article key={artifact.id} className="rounded-md border border-zinc-800 bg-zinc-900 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="text-sm font-semibold">{artifact.title}</h3>
                          <span className="text-xs text-zinc-400">{artifact.type}</span>
                        </div>
                        <ArtifactPreview artifact={artifact} />
                      </article>
                    ))
                  ) : (
                    <p className="text-sm text-zinc-500">No artifacts for this step.</p>
                  )}
                </div>
              ) : null}

              {tab === "summary" ? (
                <div className="rounded border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-200">
                  <p>Status: {selectedStep.status}</p>
                  <p className="mt-2">{selectedStep.summary ?? "No summary provided."}</p>
                  <p className="mt-3 text-xs text-zinc-400">
                    Artifacts: {selectedStep.artifacts.length} | Log lines: {selectedStep.logs.length}
                  </p>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">Select a step.</p>
          )}
        </section>
      </div>
    </div>
  );
}
