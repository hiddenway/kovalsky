import { create } from "zustand";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  MarkerType,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type XYPosition,
} from "reactflow";
import { AGENT_DEFINITIONS, normalizeAgentId } from "@/lib/agents";
import { exportPipelineToJson, importPipelineFromJson, readPipelinesFromStorage, writePipelinesToStorage } from "@/lib/pipeline-storage";
import type { Pipeline, PipelineNodeData, ReactFlowEdge, ReactFlowNode, StepStatus } from "@/lib/types";

function makeDefaultPipeline(): Pipeline {
  const now = new Date().toISOString();
  return {
    id: `pipe-${crypto.randomUUID()}`,
    name: "New Workflow",
    description: "",
    tags: [],
    chatRerunMode: "node",
    clearNodeChatContextOnRun: false,
    nodes: [],
    edges: [],
    updatedAt: now,
  };
}

function looksLikePristineDefaultPipeline(pipeline: Pipeline): boolean {
  return (
    pipeline.name === "New Workflow" &&
    (pipeline.description ?? "").trim().length === 0 &&
    (pipeline.tags ?? []).length === 0 &&
    (pipeline.workspacePath ?? "").trim().length === 0 &&
    pipeline.nodes.length === 0 &&
    pipeline.edges.length === 0
  );
}

function normalizeTemplatePipeline(template: Pipeline, index: number): Pipeline {
  const normalizedName = template.name?.trim() ? template.name.trim() : `Template Workflow ${index + 1}`;
  const pipelineId = template.id?.trim() || `pipe-${crypto.randomUUID()}`;
  const seenNodeIds = new Set<string>();
  const templateNodes = Array.isArray(template.nodes) ? template.nodes : [];

  const normalizedNodes: ReactFlowNode<PipelineNodeData>[] = templateNodes.map((node, nodeIndex) => {
    let nextNodeId = node.id?.trim() || `node-${crypto.randomUUID()}`;
    while (seenNodeIds.has(nextNodeId)) {
      nextNodeId = `node-${crypto.randomUUID()}`;
    }
    seenNodeIds.add(nextNodeId);

    const normalizedAgentId = normalizeAgentId(node.data?.agentId ?? "codex-cli");
    const defaultGoal = `Goal for ${normalizedAgentId}`;
    const x = typeof node.position?.x === "number" ? node.position.x : 120 + nodeIndex * 280;
    const y = typeof node.position?.y === "number" ? node.position.y : 120;
    return {
      id: nextNodeId,
      type: "agentNode",
      position: { x, y },
      data: {
        agentId: normalizedAgentId,
        goal: node.data?.goal?.trim() || defaultGoal,
        customName: node.data?.customName?.trim() || undefined,
        settings: node.data?.settings,
      },
    };
  });

  const validNodeIds = new Set(normalizedNodes.map((node) => node.id));
  const normalizedEdges: ReactFlowEdge[] = [];
  const seenEdgeIds = new Set<string>();
  const templateEdges = Array.isArray(template.edges) ? template.edges : [];
  for (const edge of templateEdges) {
    if (!validNodeIds.has(edge.source) || !validNodeIds.has(edge.target) || edge.source === edge.target) {
      continue;
    }
    let nextEdgeId = edge.id?.trim() || `edge-${crypto.randomUUID()}`;
    while (seenEdgeIds.has(nextEdgeId)) {
      nextEdgeId = `edge-${crypto.randomUUID()}`;
    }
    seenEdgeIds.add(nextEdgeId);
    normalizedEdges.push({
      id: nextEdgeId,
      source: edge.source,
      target: edge.target,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 20,
        height: 20,
        color: "#71717a",
      },
      style: {
        strokeWidth: 3,
        stroke: "#71717a",
      },
    });
  }

  return {
    id: pipelineId,
    name: normalizedName,
    description: template.description ?? "",
    tags: template.tags ?? [],
    workspacePath: "",
    chatRerunMode: template.chatRerunMode === "pipeline" ? "pipeline" : "node",
    clearNodeChatContextOnRun: template.clearNodeChatContextOnRun ?? false,
    nodes: normalizedNodes,
    edges: normalizedEdges,
    updatedAt: new Date(Date.now() - index * 1000).toISOString(),
  };
}

function withRuntimeStatus(
  nodes: ReactFlowNode<PipelineNodeData>[],
  statuses: Record<string, StepStatus | undefined>,
): ReactFlowNode<PipelineNodeData>[] {
  return nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      runtimeStatus: statuses[node.id],
    },
  }));
}

type PipelineState = {
  hydrated: boolean;
  pipelines: Pipeline[];
  activePipelineId: string;
  name: string;
  description: string;
  tags: string[];
  workspacePath: string;
  chatRerunMode: "node" | "pipeline";
  clearNodeChatContextOnRun: boolean;
  nodes: ReactFlowNode<PipelineNodeData>[];
  edges: ReactFlowEdge[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  init: (pipelineId?: string | null) => void;
  createPipeline: (workspacePath?: string) => string;
  openPipeline: (pipelineId: string) => void;
  saveActivePipeline: () => void;
  deletePipeline: (pipelineId: string) => void;
  duplicatePipeline: (pipelineId: string) => string | null;
  updateMetadata: (payload: {
    name?: string;
    description?: string;
    tags?: string[];
    workspacePath?: string;
    chatRerunMode?: "node" | "pipeline";
    clearNodeChatContextOnRun?: boolean;
  }) => void;
  setNodes: (nodes: ReactFlowNode<PipelineNodeData>[]) => void;
  setEdges: (edges: ReactFlowEdge[]) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  addNodeFromAgent: (agentId: string, position?: XYPosition) => string;
  duplicateSelectedNode: () => void;
  deleteSelectedNodes: () => void;
  deleteSelectedEdge: () => void;
  setSelectedNodeName: (name: string) => void;
  setSelectedNodeGoal: (goal: string) => void;
  setSelectedNodeSettings: (settings: Record<string, unknown>) => void;
  setSelection: (payload: { nodeId?: string | null; edgeId?: string | null }) => void;
  exportActivePipeline: () => string;
  importPipelineJson: (json: string) => string;
  seedTemplatePipelines: (templates: Pipeline[]) => number;
  applyStepStatuses: (statuses: Record<string, StepStatus | undefined>) => void;
  clearStepStatuses: () => void;
  getActivePipelineSnapshot: () => Pipeline;
};

export const usePipelineStore = create<PipelineState>((set, get) => ({
  hydrated: false,
  pipelines: [],
  activePipelineId: "",
  name: "New Workflow",
  description: "",
  tags: [],
  workspacePath: "",
  chatRerunMode: "node",
  clearNodeChatContextOnRun: false,
  nodes: [],
  edges: [],
  selectedNodeId: null,
  selectedEdgeId: null,
  init: (pipelineId) => {
    const stored = readPipelinesFromStorage();
    if (stored.length === 0) {
      const created = makeDefaultPipeline();
      writePipelinesToStorage([created]);
      set({
        hydrated: true,
        pipelines: [created],
        activePipelineId: created.id,
        name: created.name,
        description: created.description ?? "",
        tags: created.tags ?? [],
        workspacePath: created.workspacePath ?? "",
        chatRerunMode: created.chatRerunMode === "pipeline" ? "pipeline" : "node",
        clearNodeChatContextOnRun: created.clearNodeChatContextOnRun ?? false,
        nodes: created.nodes,
        edges: created.edges,
      });
      return;
    }

    const target =
      (pipelineId ? stored.find((pipeline) => pipeline.id === pipelineId) : null) ??
      stored.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

    set({
      hydrated: true,
      pipelines: stored,
      activePipelineId: target.id,
      name: target.name,
      description: target.description ?? "",
      tags: target.tags ?? [],
      workspacePath: target.workspacePath ?? "",
      chatRerunMode: target.chatRerunMode === "pipeline" ? "pipeline" : "node",
      clearNodeChatContextOnRun: target.clearNodeChatContextOnRun ?? false,
      nodes: target.nodes,
      edges: target.edges,
      selectedNodeId: null,
      selectedEdgeId: null,
    });
  },
  createPipeline: (workspacePath) => {
    const current = get();
    const created: Pipeline = {
      ...makeDefaultPipeline(),
      workspacePath: workspacePath?.trim() ?? "",
      chatRerunMode: "node",
      clearNodeChatContextOnRun: false,
    };
    const pipelines = [created, ...current.pipelines];

    writePipelinesToStorage(pipelines);

    set({
      pipelines,
      activePipelineId: created.id,
      name: created.name,
      description: created.description ?? "",
      tags: created.tags ?? [],
      workspacePath: created.workspacePath ?? "",
      chatRerunMode: created.chatRerunMode === "pipeline" ? "pipeline" : "node",
      clearNodeChatContextOnRun: created.clearNodeChatContextOnRun ?? false,
      nodes: created.nodes,
      edges: created.edges,
      selectedNodeId: null,
      selectedEdgeId: null,
    });

    return created.id;
  },
  openPipeline: (pipelineId) => {
    const pipeline = get().pipelines.find((item) => item.id === pipelineId);
    if (!pipeline) {
      return;
    }

    set({
      activePipelineId: pipeline.id,
      name: pipeline.name,
      description: pipeline.description ?? "",
      tags: pipeline.tags ?? [],
      workspacePath: pipeline.workspacePath ?? "",
      chatRerunMode: pipeline.chatRerunMode === "pipeline" ? "pipeline" : "node",
      clearNodeChatContextOnRun: pipeline.clearNodeChatContextOnRun ?? false,
      nodes: pipeline.nodes,
      edges: pipeline.edges,
      selectedNodeId: null,
      selectedEdgeId: null,
    });
  },
  saveActivePipeline: () => {
    const state = get();
    const updated: Pipeline = {
      id: state.activePipelineId,
      name: state.name.trim() || "Untitled Workflow",
      description: state.description,
      tags: state.tags,
      workspacePath: state.workspacePath,
      chatRerunMode: state.chatRerunMode,
      clearNodeChatContextOnRun: state.clearNodeChatContextOnRun,
      nodes: state.nodes,
      edges: state.edges,
      updatedAt: new Date().toISOString(),
    };

    const pipelines = state.pipelines.some((item) => item.id === updated.id)
      ? state.pipelines.map((item) => (item.id === updated.id ? updated : item))
      : [updated, ...state.pipelines];

    writePipelinesToStorage(pipelines);

    set({
      pipelines,
      activePipelineId: updated.id,
      name: updated.name,
      description: updated.description ?? "",
      tags: updated.tags ?? [],
      workspacePath: updated.workspacePath ?? "",
      chatRerunMode: updated.chatRerunMode === "pipeline" ? "pipeline" : "node",
      clearNodeChatContextOnRun: updated.clearNodeChatContextOnRun ?? false,
      nodes: updated.nodes,
      edges: updated.edges,
    });
  },
  deletePipeline: (pipelineId) => {
    const state = get();
    const pipelines = state.pipelines.filter((item) => item.id !== pipelineId);

    if (pipelines.length === 0) {
      const created = makeDefaultPipeline();
      writePipelinesToStorage([created]);
      set({
        pipelines: [created],
        activePipelineId: created.id,
        name: created.name,
        description: created.description ?? "",
        tags: created.tags ?? [],
        workspacePath: created.workspacePath ?? "",
        chatRerunMode: created.chatRerunMode === "pipeline" ? "pipeline" : "node",
        clearNodeChatContextOnRun: created.clearNodeChatContextOnRun ?? false,
        nodes: created.nodes,
        edges: created.edges,
        selectedNodeId: null,
        selectedEdgeId: null,
      });
      return;
    }

    writePipelinesToStorage(pipelines);

    if (state.activePipelineId === pipelineId) {
      const next = pipelines[0];
      set({
        pipelines,
        activePipelineId: next.id,
        name: next.name,
        description: next.description ?? "",
        tags: next.tags ?? [],
        workspacePath: next.workspacePath ?? "",
        chatRerunMode: next.chatRerunMode === "pipeline" ? "pipeline" : "node",
        clearNodeChatContextOnRun: next.clearNodeChatContextOnRun ?? false,
        nodes: next.nodes,
        edges: next.edges,
        selectedNodeId: null,
        selectedEdgeId: null,
      });
      return;
    }

    set({ pipelines });
  },
  duplicatePipeline: (pipelineId) => {
    const state = get();
    const source = state.pipelines.find((item) => item.id === pipelineId);

    if (!source) {
      return null;
    }

    const duplicated: Pipeline = {
      ...source,
      id: `pipe-${crypto.randomUUID()}`,
      name: `${source.name} Copy`,
      updatedAt: new Date().toISOString(),
      chatRerunMode: source.chatRerunMode === "pipeline" ? "pipeline" : "node",
      clearNodeChatContextOnRun: source.clearNodeChatContextOnRun ?? false,
      nodes: source.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          runtimeStatus: undefined,
          handoff: undefined,
        },
      })),
    };

    const pipelines = [duplicated, ...state.pipelines];
    writePipelinesToStorage(pipelines);

    set({
      pipelines,
      activePipelineId: duplicated.id,
      name: duplicated.name,
      description: duplicated.description ?? "",
      tags: duplicated.tags ?? [],
      workspacePath: duplicated.workspacePath ?? "",
      chatRerunMode: duplicated.chatRerunMode === "pipeline" ? "pipeline" : "node",
      clearNodeChatContextOnRun: duplicated.clearNodeChatContextOnRun ?? false,
      nodes: duplicated.nodes,
      edges: duplicated.edges,
      selectedNodeId: null,
      selectedEdgeId: null,
    });

    return duplicated.id;
  },
  updateMetadata: (payload) => {
    set((state) => ({
      name: payload.name ?? state.name,
      description: payload.description ?? state.description,
      tags: payload.tags ?? state.tags,
      workspacePath: payload.workspacePath ?? state.workspacePath,
      chatRerunMode: payload.chatRerunMode ?? state.chatRerunMode,
      clearNodeChatContextOnRun: payload.clearNodeChatContextOnRun ?? state.clearNodeChatContextOnRun,
    }));
  },
  setNodes: (nodes) => {
    set({ nodes });
  },
  setEdges: (edges) => {
    set({ edges });
  },
  onNodesChange: (changes) => {
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes),
    }));
  },
  onEdgesChange: (changes) => {
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
    }));
  },
  onConnect: (connection) => {
    set((state) => ({
      edges: addEdge(
        {
          ...connection,
          id: `edge-${crypto.randomUUID()}`,
          animated: false,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 20,
            height: 20,
            color: "#71717a",
          },
          style: {
            strokeWidth: 3,
            stroke: "#71717a",
          },
        },
        state.edges,
      ),
    }));
  },
  addNodeFromAgent: (agentId, position) => {
    const state = get();
    const normalizedAgentId = normalizeAgentId(agentId);
    const definition = AGENT_DEFINITIONS.find((agent) => agent.id === normalizedAgentId);
    const selected = state.selectedNodeId ? state.nodes.find((node) => node.id === state.selectedNodeId) : null;

    const nodeId = `node-${crypto.randomUUID()}`;
    const fallbackX = state.nodes.length * 80 + 120;
    const fallbackY = state.nodes.length * 24 + 120;
    const nextPosition = position ?? {
      x: selected ? selected.position.x + 260 : fallbackX,
      y: selected ? selected.position.y + 40 : fallbackY,
    };

    const created: ReactFlowNode<PipelineNodeData> = {
      id: nodeId,
      type: "agentNode",
      position: nextPosition,
      data: {
        agentId: normalizedAgentId,
        goal: `Goal for ${definition?.title ?? agentId}`,
      },
    };

    const nextEdges =
      selected && selected.id !== nodeId
        ? addEdge(
            {
              id: `edge-${crypto.randomUUID()}`,
              source: selected.id,
              target: nodeId,
              markerEnd: {
                type: MarkerType.ArrowClosed,
                width: 20,
                height: 20,
                color: "#71717a",
              },
              style: {
                strokeWidth: 3,
                stroke: "#71717a",
              },
            },
            state.edges,
          )
        : state.edges;

    set({
      nodes: [...state.nodes, created],
      edges: nextEdges,
      selectedNodeId: nodeId,
      selectedEdgeId: null,
    });

    return nodeId;
  },
  duplicateSelectedNode: () => {
    const state = get();
    const selected = state.selectedNodeId ? state.nodes.find((node) => node.id === state.selectedNodeId) : null;

    if (!selected) {
      return;
    }

    const duplicated: ReactFlowNode<PipelineNodeData> = {
      ...selected,
      id: `node-${crypto.randomUUID()}`,
      position: {
        x: selected.position.x + 36,
        y: selected.position.y + 36,
      },
      selected: false,
      data: {
        ...selected.data,
        runtimeStatus: undefined,
      },
    };

    set((current) => ({
      nodes: [...current.nodes, duplicated],
      selectedNodeId: duplicated.id,
      selectedEdgeId: null,
    }));
  },
  deleteSelectedNodes: () => {
    set((state) => {
      const selectedNodeIds = state.nodes.filter((node) => node.selected).map((node) => node.id);
      const removeIds = state.selectedNodeId ? new Set([...selectedNodeIds, state.selectedNodeId]) : new Set(selectedNodeIds);
      const selectedEdgeIds = state.edges.filter((edge) => edge.selected).map((edge) => edge.id);
      const removeEdgeIds = state.selectedEdgeId
        ? new Set([...selectedEdgeIds, state.selectedEdgeId])
        : new Set(selectedEdgeIds);

      if (removeIds.size === 0 && removeEdgeIds.size === 0) {
        return state;
      }

      return {
        nodes: state.nodes.filter((node) => !removeIds.has(node.id)),
        edges: state.edges.filter(
          (edge) =>
            !removeIds.has(edge.source) &&
            !removeIds.has(edge.target) &&
            !removeEdgeIds.has(edge.id),
        ),
        selectedNodeId: null,
        selectedEdgeId: null,
      };
    });
  },
  deleteSelectedEdge: () => {
    set((state) => {
      if (!state.selectedEdgeId) {
        return state;
      }
      return {
        edges: state.edges.filter((edge) => edge.id !== state.selectedEdgeId),
        selectedEdgeId: null,
      };
    });
  },
  setSelectedNodeName: (name) => {
    set((state) => {
      if (!state.selectedNodeId) {
        return state;
      }

      return {
        nodes: state.nodes.map((node) =>
          node.id === state.selectedNodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  customName: name,
                },
              }
            : node,
        ),
      };
    });
  },
  setSelectedNodeGoal: (goal) => {
    set((state) => {
      if (!state.selectedNodeId) {
        return state;
      }

      return {
        nodes: state.nodes.map((node) =>
          node.id === state.selectedNodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  goal,
                  handoff: undefined,
                },
              }
            : node,
        ),
      };
    });
  },
  setSelectedNodeSettings: (settings) => {
    set((state) => {
      if (!state.selectedNodeId) {
        return state;
      }

      return {
        nodes: state.nodes.map((node) =>
          node.id === state.selectedNodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  settings,
                  handoff: undefined,
                },
              }
            : node,
        ),
      };
    });
  },
  setSelection: ({ nodeId, edgeId }) => {
    set({
      selectedNodeId: nodeId ?? null,
      selectedEdgeId: edgeId ?? null,
    });
  },
  exportActivePipeline: () => {
    const snapshot = get().getActivePipelineSnapshot();
    return exportPipelineToJson(snapshot);
  },
  importPipelineJson: (json) => {
    const pipeline = importPipelineFromJson(json);
    const state = get();

    const normalized: Pipeline = {
      ...pipeline,
      id: pipeline.id || `pipe-${crypto.randomUUID()}`,
      name: pipeline.name || "Imported Workflow",
      chatRerunMode: pipeline.chatRerunMode === "pipeline" ? "pipeline" : "node",
      clearNodeChatContextOnRun: pipeline.clearNodeChatContextOnRun ?? false,
      updatedAt: new Date().toISOString(),
      nodes: pipeline.nodes.map((node) => ({
        ...node,
        type: node.type ?? "agentNode",
        data: {
          ...node.data,
          runtimeStatus: undefined,
          handoff: undefined,
        },
      })),
    };

    const next = state.pipelines.some((item) => item.id === normalized.id)
      ? state.pipelines.map((item) => (item.id === normalized.id ? normalized : item))
      : [normalized, ...state.pipelines];

    writePipelinesToStorage(next);

    set({
      pipelines: next,
      activePipelineId: normalized.id,
      name: normalized.name,
      description: normalized.description ?? "",
      tags: normalized.tags ?? [],
      workspacePath: normalized.workspacePath ?? "",
      chatRerunMode: normalized.chatRerunMode === "pipeline" ? "pipeline" : "node",
      clearNodeChatContextOnRun: normalized.clearNodeChatContextOnRun ?? false,
      nodes: normalized.nodes,
      edges: normalized.edges,
      selectedNodeId: null,
      selectedEdgeId: null,
    });

    return normalized.id;
  },
  seedTemplatePipelines: (templates) => {
    const state = get();
    if (templates.length === 0) {
      return 0;
    }
    if (state.pipelines.length !== 1 || !looksLikePristineDefaultPipeline(state.pipelines[0])) {
      return 0;
    }

    const normalized = templates
      .map((template, index) => normalizeTemplatePipeline(template, index))
      .filter((pipeline) => pipeline.nodes.length > 0);
    if (normalized.length === 0) {
      return 0;
    }

    writePipelinesToStorage(normalized);
    const first = normalized[0];
    set({
      pipelines: normalized,
      activePipelineId: first.id,
      name: first.name,
      description: first.description ?? "",
      tags: first.tags ?? [],
      workspacePath: first.workspacePath ?? "",
      chatRerunMode: first.chatRerunMode === "pipeline" ? "pipeline" : "node",
      clearNodeChatContextOnRun: first.clearNodeChatContextOnRun ?? false,
      nodes: first.nodes,
      edges: first.edges,
      selectedNodeId: null,
      selectedEdgeId: null,
    });

    return normalized.length;
  },
  applyStepStatuses: (statuses) => {
    set((state) => ({
      nodes: withRuntimeStatus(state.nodes, statuses),
    }));
  },
  clearStepStatuses: () => {
    set((state) => ({
      nodes: state.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          runtimeStatus: undefined,
          handoff: undefined,
        },
      })),
    }));
  },
  getActivePipelineSnapshot: () => {
    const state = get();
    return {
      id: state.activePipelineId,
      name: state.name,
      description: state.description,
      tags: state.tags,
      workspacePath: state.workspacePath.trim() || undefined,
      chatRerunMode: state.chatRerunMode,
      clearNodeChatContextOnRun: state.clearNodeChatContextOnRun,
      nodes: state.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          agentId: normalizeAgentId(node.data.agentId),
          runtimeStatus: undefined,
          handoff: undefined,
        },
      })),
      edges: state.edges,
      updatedAt: new Date().toISOString(),
    };
  },
}));
