"use client";

import type { AgentDefinition } from "@/lib/types";
import { Button } from "@/components/ui/button";

type Props = {
  agents: AgentDefinition[];
  onAddAgent: (agentId: string) => void;
};

export function AgentsLibrary({ agents, onAddAgent }: Props): React.JSX.Element {
  return (
    <aside className="flex h-full flex-col border-r border-zinc-800 bg-zinc-950/70">
      <div className="border-b border-zinc-800 px-3 py-2">
        <h2 className="text-sm font-semibold text-zinc-100">Agents Library</h2>
        <p className="text-xs text-zinc-400">Drag to canvas or click Add</p>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {agents.map((agent) => (
          <div
            key={agent.id}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("application/kovalski-agent", agent.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            className="rounded-lg border border-zinc-800 bg-zinc-900/80 p-3"
          >
            <p className="text-sm font-semibold text-zinc-100">
              {agent.icon ? `${agent.icon} ` : ""}
              {agent.title}
            </p>
            <p className="mt-1 text-xs text-zinc-400">{agent.description}</p>
            <Button
              type="button"
              variant="secondary"
              className="mt-2 w-full"
              onClick={() => onAddAgent(agent.id)}
            >
              Add
            </Button>
          </div>
        ))}
      </div>
    </aside>
  );
}
