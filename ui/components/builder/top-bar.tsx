"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

type Props = {
  pipelineName: string;
  isRunning: boolean;
  runDisabledReason?: string | null;
  backHref: string;
  onNameChange: (value: string) => void;
  onRun: () => void;
  onCancelRun: () => void;
  onSave: () => void;
  onExport: () => void;
  onImport: () => void;
  onPublish: () => void;
  onDuplicateNode: () => void;
};

export function TopBar({
  pipelineName,
  isRunning,
  runDisabledReason,
  backHref,
  onNameChange,
  onRun,
  onCancelRun,
  onSave,
  onExport,
  onImport,
  onPublish,
  onDuplicateNode,
}: Props): React.JSX.Element {
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-950/90 px-3 py-2">
      <Link
        href={backHref}
        className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 transition hover:bg-zinc-800"
      >
        ← Workflows
      </Link>
      <Link
        href="/runs"
        className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 transition hover:bg-zinc-800"
      >
        Runs
      </Link>
      <Link
        href="/settings"
        className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 transition hover:bg-zinc-800"
      >
        Settings
      </Link>

      <input
        value={pipelineName}
        onChange={(event) => onNameChange(event.target.value)}
        className="min-w-[220px] flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
        placeholder="Workflow Name"
      />

      {isRunning ? (
        <Button type="button" variant="danger" onClick={onCancelRun}>
          Cancel Workflow
        </Button>
      ) : (
        <Button type="button" onClick={onRun} disabled={Boolean(runDisabledReason)} title={runDisabledReason ?? undefined}>
          {runDisabledReason ? "Trigger-Controlled" : "Run"}
        </Button>
      )}
      <Button type="button" variant="secondary" onClick={onSave}>
        Save
      </Button>
      <Button type="button" variant="secondary" onClick={onExport}>
        Export
      </Button>
      <Button type="button" variant="secondary" onClick={onImport}>
        Import
      </Button>
      <Button type="button" variant="secondary" onClick={onDuplicateNode}>
        Duplicate Node
      </Button>
      <Button type="button" variant="secondary" onClick={onPublish}>
        Publish
      </Button>
    </header>
  );
}
