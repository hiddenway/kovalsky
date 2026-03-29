"use client";

import { useState } from "react";
import type { AgentDefinition } from "@/lib/types";
import { Button } from "@/components/ui/button";
import type { InstrumentDefinition } from "@/lib/instruments";

type Props = {
  agents: AgentDefinition[];
  instruments: InstrumentDefinition[];
  onAddAgent: (agentId: string) => void;
  onAddInstrument: (instrumentId: string) => void;
};

export function AgentsLibrary({ agents, instruments, onAddAgent, onAddInstrument }: Props): React.JSX.Element {
  const [section, setSection] = useState<"agents" | "instruments">("agents");

  return (
    <aside className="flex h-full flex-col border-r border-zinc-800 bg-zinc-950/70">
      <div className="border-b border-zinc-800 px-3 py-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">
              {section === "agents" ? "Agents Library" : "Instrument Library"}
            </h2>
            <p className="text-xs text-zinc-400">
              {section === "agents" ? "Drag to canvas or click Add" : "Reusable trigger scripts and integrations"}
            </p>
          </div>
          <div className="mt-0.5 flex rounded-md border border-zinc-700 bg-zinc-900 p-0.5">
            <button
              type="button"
              className={`rounded px-2 py-1 text-[11px] font-medium ${
                section === "agents"
                  ? "bg-cyan-500/20 text-cyan-100"
                  : "text-zinc-300 hover:bg-zinc-800"
              }`}
              onClick={() => setSection("agents")}
            >
              Agents
            </button>
            <button
              type="button"
              className={`rounded px-2 py-1 text-[11px] font-medium ${
                section === "instruments"
                  ? "bg-cyan-500/20 text-cyan-100"
                  : "text-zinc-300 hover:bg-zinc-800"
              }`}
              onClick={() => setSection("instruments")}
            >
              Tools
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {section === "agents" ? (
          agents.map((agent) => (
            <div
              key={agent.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData("application/kovalsky-agent", agent.id);
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
          ))
        ) : (
          instruments.map((instrument) => (
            <div
              key={instrument.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData("application/kovalsky-instrument", instrument.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              className="rounded-lg border border-zinc-800 bg-zinc-900/80 p-3"
            >
              <p className="text-sm font-semibold text-zinc-100">
                {instrument.icon ? `${instrument.icon} ` : ""}
                {instrument.title}
              </p>
              <p className="mt-1 text-xs text-zinc-400">{instrument.description}</p>
              <Button
                type="button"
                variant="secondary"
                className="mt-2 w-full"
                onClick={() => onAddInstrument(instrument.id)}
              >
                Add
              </Button>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
