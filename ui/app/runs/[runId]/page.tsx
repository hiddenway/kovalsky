"use client";

import { useParams } from "next/navigation";
import { RunDetailsPage } from "@/components/runs/run-details-page";

export default function RunRoute(): React.JSX.Element {
  const params = useParams<{ runId: string }>();
  const runId = params.runId;

  return <RunDetailsPage runId={runId} />;
}
