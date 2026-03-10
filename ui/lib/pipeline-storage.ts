import type { Pipeline } from "@/lib/types";

const PIPELINES_STORAGE_KEY = "kovalsky:pipelines";

function clonePipelineForSave(pipeline: Pipeline): Pipeline {
  return {
    ...pipeline,
    nodes: pipeline.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        runtimeStatus: undefined,
        handoff: undefined,
      },
    })),
  };
}

export function readPipelinesFromStorage(): Pipeline[] {
  if (typeof window === "undefined") {
    return [];
  }

  const raw = window.localStorage.getItem(PIPELINES_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as Pipeline[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writePipelinesToStorage(pipelines: Pipeline[]): void {
  if (typeof window === "undefined") {
    return;
  }

  const sanitized = pipelines.map(clonePipelineForSave);
  window.localStorage.setItem(PIPELINES_STORAGE_KEY, JSON.stringify(sanitized));
}

export function exportPipelineToJson(pipeline: Pipeline): string {
  return JSON.stringify(clonePipelineForSave(pipeline), null, 2);
}

export function importPipelineFromJson(json: string): Pipeline {
  const parsed = JSON.parse(json) as Pipeline;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid workflow JSON");
  }

  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error("Workflow must include nodes and edges arrays");
  }

  return {
    ...parsed,
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
  };
}

export { PIPELINES_STORAGE_KEY };
