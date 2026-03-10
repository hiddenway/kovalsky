import fs from "node:fs";
import { DatabaseService } from "../db";
import { collectPredecessors } from "../core/graph";
import type { ArtifactRecord, HandoffPacket, NodeExecutionPlan, PipelineGraph, ResolvedInputs } from "../types";

function normalizeType(input: string): string {
  return input.trim().toLowerCase();
}

export class ArtifactResolver {
  constructor(private readonly db: DatabaseService) {}

  resolveForStep(runId: string, graph: PipelineGraph, nodeId: string, nodePlan: NodeExecutionPlan): ResolvedInputs {
    const predecessors = collectPredecessors(graph, nodeId);
    const predecessorArtifacts = this.db.listArtifactsForResolver(runId).filter((item) => predecessors.has(item.node_id));

    const inputsByType: Record<string, ArtifactRecord[]> = {};
    const artifactsByNormalizedType = new Map<string, Array<ArtifactRecord & { node_id: string }>>();
    const canonicalTypeByNormalized = new Map<string, string>();
    const handoffs: ResolvedInputs["handoffs"] = [];

    for (const artifact of predecessorArtifacts) {
      const normalizedType = normalizeType(artifact.type);
      if (!canonicalTypeByNormalized.has(normalizedType)) {
        canonicalTypeByNormalized.set(normalizedType, artifact.type);
      }
      if (!artifactsByNormalizedType.has(normalizedType)) {
        artifactsByNormalizedType.set(normalizedType, []);
      }
      artifactsByNormalizedType.get(normalizedType)?.push(artifact);

      if (normalizedType !== "handoffpacket") {
        continue;
      }

      let packet: HandoffPacket | null = null;
      try {
        if (fs.existsSync(artifact.path)) {
          const raw = fs.readFileSync(artifact.path, "utf8");
          packet = JSON.parse(raw) as HandoffPacket;
        }
      } catch {
        packet = null;
      }

      handoffs.push({
        fromNodeId: artifact.node_id,
        artifact,
        packet,
      });
    }

    for (const [normalizedType, bucket] of artifactsByNormalizedType.entries()) {
      const key = canonicalTypeByNormalized.get(normalizedType) ?? normalizedType;
      inputsByType[key] = [...bucket];
    }

    const preferredSources = new Set(nodePlan.receivesFrom);
    const filteredHandoffs = preferredSources.size > 0
      ? handoffs.filter((item) => preferredSources.has(item.fromNodeId))
      : handoffs;

    return {
      inputsByType,
      predecessorArtifacts,
      handoffs: filteredHandoffs,
    };
  }
}
