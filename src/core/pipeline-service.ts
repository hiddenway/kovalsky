import { DatabaseService } from "../db";
import { PluginRegistry } from "../plugins/registry";
import { validateDag } from "./graph";
import type { PipelineGraph, PipelineRecord } from "../types";

export class PipelineService {
  constructor(
    private readonly db: DatabaseService,
    private readonly pluginRegistry: PluginRegistry,
  ) {}

  validateGraph(graph: PipelineGraph): void {
    validateDag(graph);

    for (const node of graph.nodes) {
      const plugin = this.pluginRegistry.get(node.agentId);
      if (!plugin) {
        throw new Error(`Unknown agentId: ${node.agentId}`);
      }

      const needsGoal = true;
      if (needsGoal && !(node.goal ?? "").trim()) {
        throw new Error(`Node ${node.id} must define goal`);
      }
    }
  }

  createPipeline(name: string, graph: PipelineGraph): PipelineRecord {
    this.validateGraph(graph);
    return this.db.createPipeline(name, JSON.stringify(graph));
  }

  getPipeline(id: string): PipelineRecord | null {
    return this.db.getPipeline(id);
  }

  updatePipeline(id: string, name: string, graph: PipelineGraph): PipelineRecord | null {
    this.validateGraph(graph);
    return this.db.updatePipeline(id, name, JSON.stringify(graph));
  }
}
