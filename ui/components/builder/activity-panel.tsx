"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import type { RunRecord, StepRun } from "@/lib/types";

type Props = {
  record: RunRecord | null;
  onOpenInspector?: () => void;
  onOpenChat?: () => void;
  activeSection?: "inspector" | "chat" | null;
};

type ActivityItem = {
  id: string;
  nodeId: string;
  nodeTitle: string;
  agentId: string;
  statusLabel: string;
  timestamp: string;
  summary: string;
  highlight: string;
  artifactsCount: number;
  logsCount: number;
  goal: string;
  imagePreview: string | null;
};

const TECHNICAL_LOG_PATTERNS = [
  /^\[(stdout|stderr)\]\s*/i,
  /^\$ /,
  /^(npm|pnpm|yarn|git|node|bash|sh)\b/i,
  /^(create|write|read|delete|update)\b/i,
  /^(file|path|command|exit code)\b/i,
];

function toHumanLogLine(line: string): string {
  return line.replace(/^\[[^\]]+\]\s*/i, "").trim();
}

function isTechnicalLog(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) {
    return true;
  }
  if (/^[\[\]{}(),:]+$/.test(normalized)) {
    return true;
  }
  if (TECHNICAL_LOG_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (normalized.startsWith("{") || normalized.startsWith("[")) {
    return true;
  }
  return false;
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

function toStatusLabel(step: StepRun, loopWaiting: boolean): string {
  if (loopWaiting && step.agentId === "loop" && step.status === "success" && step.logs.some((line) => /loop status:\s*waiting/i.test(line))) {
    return "waiting";
  }
  if (step.awaitingUserInput && step.status === "pending") {
    return "awaiting";
  }
  return step.status;
}

function trimTo(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function toEpoch(iso: string): number {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : 0;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "unknown time";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function pickImagePreview(step: StepRun): string | null {
  for (const artifact of step.artifacts) {
    const preview = typeof artifact.preview === "string" ? artifact.preview.trim() : "";
    if (!preview) {
      continue;
    }
    const mime = (artifact.mime ?? "").toLowerCase();
    if (mime.startsWith("image/")) {
      return preview;
    }
    if (preview.startsWith("data:image/")) {
      return preview;
    }
    if (/^https?:\/\//i.test(preview) && /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(preview)) {
      return preview;
    }
  }
  return null;
}

function buildActivityItems(record: RunRecord): ActivityItem[] {
  return record.steps
    .map((step) => {
      const node = record.pipelineSnapshot.nodes.find((item) => item.id === step.stepId);
      const nodeTitle = node?.data.customName?.trim() || step.agentId;
      const statusLabel = toStatusLabel(step, record.run.loopWaiting === true);
      const timestamp = step.finishedAt ?? step.startedAt ?? record.run.startedAt;
      const summary = trimTo(step.summary?.trim() || "No summary yet.", 220);
      const goal = trimTo(node?.data.goal?.trim() || "", 180);

      const highlightFromLogs = step.logs
        .map(toHumanLogLine)
        .filter((line) => !isTechnicalLog(line))
        .slice(-1)[0];
      const highlightFromArtifacts = step.artifacts[0] ? `${step.artifacts[0].title} (${step.artifacts[0].type})` : "";
      const highlight = trimTo(highlightFromLogs || highlightFromArtifacts || "No visible details yet.", 180);

      return {
        id: `${step.stepId}:${step.stepRunId ?? "latest"}`,
        nodeId: step.stepId,
        nodeTitle,
        agentId: step.agentId,
        statusLabel,
        timestamp,
        summary,
        highlight,
        artifactsCount: step.artifacts.length,
        logsCount: step.logs.length,
        goal,
        imagePreview: pickImagePreview(step),
      } satisfies ActivityItem;
    })
    .sort((left, right) => toEpoch(right.timestamp) - toEpoch(left.timestamp));
}

export function ActivityPanel({
  record,
  onOpenInspector,
  onOpenChat,
  activeSection = null,
}: Props): React.JSX.Element {
  const items = useMemo(() => (record ? buildActivityItems(record) : []), [record]);

  return (
    <aside className="flex h-full min-h-0 flex-col border border-zinc-800 bg-zinc-950/95 p-3 shadow-2xl backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-400">Activity</p>
          <p className="text-xs text-zinc-500">
            {record
              ? `Run ${record.run.id.slice(0, 8)} · ${items.length} agent${items.length === 1 ? "" : "s"}`
              : "No active run"}
          </p>
        </div>
        <span
          className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            statusClass(record?.run.status ?? "queued")
          }`}
        >
          {record?.run.status ?? "idle"}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 overflow-x-auto pb-1">
        <div className="flex shrink-0 flex-nowrap gap-2">
          {record ? (
            <Link
              href={`/runs/${record.run.id}`}
              className="whitespace-nowrap rounded-md border border-cyan-400/50 bg-cyan-500/20 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/30"
            >
              Open Run
            </Link>
          ) : null}
          {onOpenInspector ? (
            <Button
              type="button"
              variant={activeSection === "inspector" ? "default" : "secondary"}
              className="shrink-0 whitespace-nowrap px-3 py-1.5 text-xs"
              onClick={onOpenInspector}
            >
              Inspector
            </Button>
          ) : null}
          {onOpenChat ? (
            <Button
              type="button"
              variant={activeSection === "chat" ? "default" : "secondary"}
              className="shrink-0 whitespace-nowrap px-3 py-1.5 text-xs"
              onClick={onOpenChat}
            >
              Chat with Agent
            </Button>
          ) : null}
        </div>
      </div>

      {!record ? (
        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-500">
          Run workflow to see agent activity and result cards here.
        </div>
      ) : items.length === 0 ? (
        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-500">
          Waiting for first step events.
        </div>
      ) : (
        <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {items.map((item) => (
            <article key={item.id} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-[11px] lowercase text-zinc-400">
                  {item.agentId} · {formatTime(item.timestamp)}
                </p>
                <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusClass(item.statusLabel)}`}>
                  {item.statusLabel}
                </span>
              </div>

              <p className="mt-1 truncate text-sm font-semibold text-zinc-100">{item.nodeTitle}</p>
              <p className="mt-1 text-sm text-zinc-200">{item.summary}</p>
              <p className="mt-1 text-xs text-zinc-400">{item.highlight}</p>
              {item.goal ? <p className="mt-1 line-clamp-2 text-[11px] text-zinc-500">Goal: {item.goal}</p> : null}

              {item.imagePreview ? (
                <img
                  src={item.imagePreview}
                  alt={`${item.nodeTitle} preview`}
                  className="mt-2 max-h-40 w-full rounded border border-zinc-800 object-cover"
                />
              ) : null}

              <p className="mt-2 text-[11px] text-zinc-500">
                {item.artifactsCount} artifact{item.artifactsCount === 1 ? "" : "s"} · {item.logsCount} log line
                {item.logsCount === 1 ? "" : "s"}
              </p>
            </article>
          ))}
        </div>
      )}
    </aside>
  );
}
