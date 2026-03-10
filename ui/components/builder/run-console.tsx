"use client";

import Link from "next/link";
import type { RunRecord } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  run: RunRecord | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onCancel: () => void;
};

const RUN_BADGE: Record<string, string> = {
  queued: "bg-zinc-800 text-zinc-300 border-zinc-700",
  running: "bg-amber-950 text-amber-300 border-amber-700/60",
  success: "bg-emerald-950 text-emerald-300 border-emerald-700/60",
  failed: "bg-rose-950 text-rose-300 border-rose-700/60",
  canceled: "bg-zinc-900 text-zinc-400 border-zinc-700",
};

export function RunConsole({ run, expanded, onToggleExpanded, onCancel }: Props): React.JSX.Element {
  const currentStep = run?.steps.find((step) => step.status === "running") ?? null;

  return (
    <section className="flex h-full min-h-0 flex-col border-t border-zinc-800 bg-zinc-950/95">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-100">Run Console</h2>
          {run ? (
            <span
              className={cn(
                "rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                RUN_BADGE[run.run.status],
              )}
            >
              {run.run.status}
            </span>
          ) : null}
          {currentStep ? <p className="text-xs text-zinc-400">Running: {currentStep.stepId}</p> : null}
        </div>

        <div className="flex items-center gap-2">
          {run?.run.status === "running" ? (
            <Button type="button" variant="danger" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          {run ? (
            <Link
              href={`/runs/${run.run.id}`}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 transition hover:bg-zinc-800"
            >
              Open Details
            </Link>
          ) : null}
          <Button type="button" variant="secondary" onClick={onToggleExpanded}>
            {expanded ? "Hide" : "Show"}
          </Button>
        </div>
      </div>

      {expanded ? (
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-hidden border-t border-zinc-800 px-3 py-3">
          <div className="min-h-0">
            <p className="mb-2 text-xs uppercase tracking-wide text-zinc-400">Steps</p>
            {run ? (
              <ul className="h-full space-y-1 overflow-y-auto text-sm">
                {run.steps.map((step) => (
                  <li key={step.stepId} className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900/70 px-2 py-1">
                    <span className="truncate text-zinc-200">{step.stepId}</span>
                    <span className="text-xs text-zinc-400">
                      {step.status}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">No runs yet.</p>
            )}
          </div>

          <div className="min-h-0">
            <p className="mb-2 text-xs uppercase tracking-wide text-zinc-400">Latest Logs</p>
            <div className="h-full space-y-1 overflow-y-auto rounded border border-zinc-800 bg-black/40 p-2 font-mono text-xs text-zinc-200">
              {run ? (
                run.steps
                  .flatMap((step) => step.logs.slice(-4))
                  .slice(-12)
                  .map((line, index) => <p key={`${line}-${index}`}>{line}</p>)
              ) : (
                <p className="text-zinc-500">Waiting for run logs...</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
