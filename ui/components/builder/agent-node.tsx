"use client";

import { memo } from "react";
import { Handle } from "reactflow";
import { getAgentById, isTriggerAgent } from "@/lib/agents";
import type { PipelineNodeData } from "@/lib/types";
import { cn } from "@/lib/utils";

type AgentNodeProps = {
  data: PipelineNodeData;
  selected?: boolean;
};

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-zinc-800 text-zinc-300 border-zinc-700",
  running: "bg-amber-950 text-amber-300 border-amber-700/60",
  success: "bg-emerald-950 text-emerald-300 border-emerald-700/60",
  failed: "bg-rose-950 text-rose-300 border-rose-700/60",
  skipped: "bg-zinc-900 text-zinc-400 border-zinc-700",
  canceled: "bg-zinc-900 text-zinc-500 border-zinc-700",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "pending",
  running: "running",
  success: "success",
  failed: "error",
  skipped: "skipped",
  canceled: "canceled",
};

function AgentNode({ data, selected = false }: AgentNodeProps): React.JSX.Element {
  const definition = getAgentById(data.agentId);
  const customName = data.customName?.trim() ?? "";
  const status = data.runtimeStatus ?? data.handoff?.status;
  const statusLabel = data.runtimeStatusLabel ?? (status ? (STATUS_LABELS[status] ?? status) : "");
  const leftPosition = "left" as never;
  const rightPosition = "right" as never;

  return (
    <div
      className={cn(
        "w-[320px] rounded-lg border bg-zinc-900/95 p-3 text-zinc-100 shadow-lg transition",
        selected ? "border-cyan-400 shadow-cyan-900/50" : "border-zinc-700",
      )}
    >
      <Handle type="target" position={leftPosition} className="!size-2 !bg-cyan-400" />
      <Handle type="source" position={rightPosition} className="!size-2 !bg-cyan-400" />

      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-400">{customName ? "Node" : "Agent"}</p>
          <p className="mt-1 text-sm font-semibold">{customName || `${definition?.icon ? `${definition.icon} ` : ""}${definition?.title ?? data.agentId}`}</p>
          {customName ? (
            <p className="mt-1 text-xs text-zinc-400">
              {definition?.icon ? `${definition.icon} ` : ""}
              {definition?.title ?? data.agentId}
            </p>
          ) : null}
        </div>
        {status ? (
          <span
            className={cn(
              "rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              STATUS_STYLES[status],
            )}
          >
            {statusLabel}
          </span>
        ) : null}
      </div>

      {!isTriggerAgent(data.agentId) ? (
        <button
          type="button"
          className={cn(
            "mt-2 w-full rounded-md border px-3 py-2 text-sm font-semibold transition",
            "border-cyan-400/80 bg-cyan-500/15 text-cyan-100 shadow-[0_0_0_1px_rgba(34,211,238,0.25)]",
            "hover:bg-cyan-500/25 hover:text-cyan-50",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/80 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900",
          )}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            data.onOpenHandoff?.();
          }}
        >
          Go to chat with Agent
        </button>
      ) : null}

      <div className="mt-2 rounded border border-zinc-800 bg-zinc-950/80 p-2 text-xs text-zinc-300">
        <p className="whitespace-pre-wrap break-words">{data.goal || "Goal is empty"}</p>
      </div>
    </div>
  );
}

export default memo(AgentNode);
