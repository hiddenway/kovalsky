"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlowProvider,
  type ReactFlowInstance,
  type XYPosition,
} from "reactflow";
import "reactflow/dist/style.css";
import AgentNode from "@/components/builder/agent-node";
import { AgentsLibrary } from "@/components/builder/agents-library";
import { InspectorPanel } from "@/components/builder/inspector-panel";
import { TopBar } from "@/components/builder/top-bar";
import { getApiClient } from "@/lib/api/client";
import { AGENT_DEFINITIONS, isTriggerAgent } from "@/lib/agents";
import { isUserCanceledFileDialog, savePipelineToFile } from "@/lib/pipeline-file-save";
import type { AgentDefinition } from "@/lib/types";
import { usePipelineStore } from "@/stores/pipeline-store";
import { useRunStore } from "@/stores/run-store";
import { useToastStore } from "@/stores/toast-store";

const NODE_TYPES = {
  agentNode: AgentNode,
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

function collectJsonTextValues(input: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: unknown[] = [input];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    if (typeof current === "string") {
      const text = current.trim();
      if (!text || seen.has(text)) {
        continue;
      }
      seen.add(text);
      out.push(text);
      continue;
    }

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      const preferredKeys = ["summary", "message", "content", "text", "result", "description", "title", "url"];
      for (const key of preferredKeys) {
        if (key in record) {
          queue.push(record[key]);
        }
      }
      for (const value of Object.values(record)) {
        queue.push(value);
      }
    }
  }

  return out;
}

function parseOpenClawJsonLogLines(logs: string[]): { comments: string[]; results: string[] } {
  const comments: string[] = [];
  const results: string[] = [];
  const jsonPayloads: Record<string, unknown>[] = [];

  let capturing = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let jsonBuffer = "";

  for (const rawLine of logs) {
    const input = `${toHumanLogLine(rawLine)}\n`;
    for (const char of input) {
      if (!capturing) {
        if (char !== "{") {
          continue;
        }
        capturing = true;
        depth = 1;
        inString = false;
        escaped = false;
        jsonBuffer = "{";
        continue;
      }

      jsonBuffer += char;

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") {
        depth += 1;
        continue;
      }
      if (char === "}") {
        depth -= 1;
        if (depth !== 0) {
          continue;
        }
        try {
          jsonPayloads.push(JSON.parse(jsonBuffer) as Record<string, unknown>);
        } catch {
          // ignore malformed json fragments
        } finally {
          capturing = false;
          depth = 0;
          inString = false;
          escaped = false;
          jsonBuffer = "";
        }
      }
    }
  }

  for (const parsed of jsonPayloads) {
    const payloadTexts = collectJsonTextValues(parsed.payloads ?? []);
    const metaTexts = collectJsonTextValues(parsed.meta ?? {});

    for (const text of payloadTexts) {
      if (comments.length >= 8) {
        break;
      }
      comments.push(text);
    }
    for (const text of metaTexts) {
      if (results.length >= 8) {
        break;
      }
      results.push(text);
    }
  }

  return {
    comments: Array.from(new Set(comments)),
    results: Array.from(new Set(results)),
  };
}

function buildFinalReport(input: {
  status: string;
  summary: string;
  comments: string[];
  results: string[];
}): string {
  const comments = input.comments.slice(0, 5);
  const results = input.results.slice(0, 8);
  const lines: string[] = [];
  lines.push(`Status: ${input.status}`);
  lines.push("");
  lines.push("Summary:");
  lines.push(input.summary.trim() || "No summary.");
  lines.push("");
  lines.push("Key comments:");
  lines.push(comments.length > 0 ? comments.map((item) => `- ${item}`).join("\n") : "- No comments.");
  lines.push("");
  lines.push("Results:");
  lines.push(results.length > 0 ? results.map((item) => `- ${item}`).join("\n") : "- No results.");
  return lines.join("\n");
}

function CanvasBuilderInner(): React.JSX.Element {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null);
  const [leftPanelWidth, setLeftPanelWidth] = useState(260);
  const [rightPanelWidth, setRightPanelWidth] = useState(320);
  const [handoffNodeId, setHandoffNodeId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<{
    type: "left" | "right";
    startX: number;
    leftWidth: number;
    rightWidth: number;
  } | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const hydrated = usePipelineStore((state) => state.hydrated);
  const activePipelineId = usePipelineStore((state) => state.activePipelineId);
  const name = usePipelineStore((state) => state.name);
  const description = usePipelineStore((state) => state.description);
  const tags = usePipelineStore((state) => state.tags);
  const workspacePath = usePipelineStore((state) => state.workspacePath);
  const chatRerunMode = usePipelineStore((state) => state.chatRerunMode);
  const clearNodeChatContextOnRun = usePipelineStore((state) => state.clearNodeChatContextOnRun);
  const nodes = usePipelineStore((state) => state.nodes);
  const edges = usePipelineStore((state) => state.edges);
  const selectedNodeId = usePipelineStore((state) => state.selectedNodeId);
  const selectedEdgeId = usePipelineStore((state) => state.selectedEdgeId);

  const initPipelines = usePipelineStore((state) => state.init);
  const saveActivePipeline = usePipelineStore((state) => state.saveActivePipeline);
  const updateMetadata = usePipelineStore((state) => state.updateMetadata);
  const onNodesChange = usePipelineStore((state) => state.onNodesChange);
  const onEdgesChange = usePipelineStore((state) => state.onEdgesChange);
  const onConnect = usePipelineStore((state) => state.onConnect);
  const addNodeFromAgent = usePipelineStore((state) => state.addNodeFromAgent);
  const setSelection = usePipelineStore((state) => state.setSelection);
  const setSelectedNodeGoal = usePipelineStore((state) => state.setSelectedNodeGoal);
  const setSelectedNodeSettings = usePipelineStore((state) => state.setSelectedNodeSettings);
  const duplicateSelectedNode = usePipelineStore((state) => state.duplicateSelectedNode);
  const deleteSelectedNodes = usePipelineStore((state) => state.deleteSelectedNodes);
  const deleteSelectedEdge = usePipelineStore((state) => state.deleteSelectedEdge);
  const setSelectedNodeName = usePipelineStore((state) => state.setSelectedNodeName);
  const exportActivePipeline = usePipelineStore((state) => state.exportActivePipeline);
  const importPipelineJson = usePipelineStore((state) => state.importPipelineJson);
  const getActivePipelineSnapshot = usePipelineStore((state) => state.getActivePipelineSnapshot);

  const runHydrated = useRunStore((state) => state.hydrated);
  const activeRunId = useRunStore((state) => state.activeRunId);
  const records = useRunStore((state) => state.records);
  const initRuns = useRunStore((state) => state.init);
  const startRun = useRunStore((state) => state.startRun);
  const attachExternalRun = useRunStore((state) => state.attachExternalRun);

  const pushToast = useToastStore((state) => state.pushToast);

  const latestRun = useMemo(() => {
    const samePipeline = records.filter((record) => record.pipelineSnapshot.id === activePipelineId);
    if (samePipeline.length === 0) {
      return null;
    }

    if (activeRunId) {
      const active = samePipeline.find((record) => record.run.id === activeRunId);
      if (active) {
        return active;
      }
    }

    return samePipeline[0] ?? null;
  }, [activePipelineId, activeRunId, records]);

  const displayNodes = useMemo(
    () =>
      nodes.map((node) => {
        const step = latestRun?.steps.find((item) => item.stepId === node.id);
        if (!step) {
          return {
            ...node,
            data: {
              ...node.data,
              handoff: undefined,
              runtimeStatusLabel: undefined,
              onOpenHandoff: () => {
                setSelection({ nodeId: node.id, edgeId: null });
                setHandoffNodeId(node.id);
              },
            },
          };
        }

        const filteredComments = step.logs
          .map(toHumanLogLine)
          .filter((line) => !isTechnicalLog(line))
          .slice(-6);
        const parsedJson = parseOpenClawJsonLogLines(step.logs);
        const comments = Array.from(new Set([...filteredComments, ...parsedJson.comments])).slice(-8);

        const results = Array.from(
          new Set([
            ...step.artifacts
              .filter((artifact) => artifact.type !== "BlackboxReport")
              .slice(0, 8)
              .map((artifact) => `${artifact.title} (${artifact.type})`),
            ...parsedJson.results,
          ]),
        ).slice(0, 10);
        const finalReport = buildFinalReport({
          status: step.status,
          summary: step.summary ?? "No summary yet.",
          comments,
          results,
        });

        return {
          ...node,
          data: {
            ...node.data,
            runtimeStatus: step.status,
            runtimeStatusLabel: undefined,
            handoff: {
              status: step.status,
              summary: step.summary ?? "No summary yet.",
              comments,
              results,
              finalReport,
            },
            onOpenHandoff: () => {
              setSelection({ nodeId: node.id, edgeId: null });
              setHandoffNodeId(node.id);
            },
          },
        };
      }),
    [latestRun, nodes, setSelection],
  );

  const selectedNode = useMemo(
    () => displayNodes.find((node) => node.id === selectedNodeId) ?? null,
    [displayNodes, selectedNodeId],
  );
  const selectedEdge = useMemo(
    () => edges.find((edge) => edge.id === selectedEdgeId) ?? null,
    [edges, selectedEdgeId],
  );
  const displayEdges = useMemo(
    () =>
      edges.map((edge) => {
        const isSelected = Boolean(edge.selected) || edge.id === selectedEdgeId;
        const stroke = isSelected ? "#22d3ee" : "#71717a";
        return {
          ...edge,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 20,
            height: 20,
            color: stroke,
          },
          style: {
            ...(edge.style ?? {}),
            stroke,
            strokeWidth: isSelected ? 4 : 3,
          },
        };
      }),
    [edges, selectedEdgeId],
  );

  const edgeArtifactTypes = useMemo(() => {
    if (!selectedEdge || !latestRun) {
      return [] as string[];
    }

    const sourceStep = latestRun.steps.find((step) => step.stepId === selectedEdge.source);
    if (!sourceStep) {
      return [] as string[];
    }

    return Array.from(new Set(sourceStep.artifacts.map((artifact) => artifact.type)));
  }, [selectedEdge, latestRun]);

  const isRunning = latestRun?.run.status === "running";
  const hasTriggerNode = useMemo(
    () => nodes.some((node) => isTriggerAgent(node.data.agentId)),
    [nodes],
  );
  const runDisabledReason = hasTriggerNode
    ? "This workflow contains a Trigger node. Start it via Generate Trigger -> Activate instead of manual Run."
    : null;

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const onMouseMove = (event: MouseEvent) => {
      const deltaX = event.clientX - dragState.startX;

      if (dragState.type === "left") {
        const next = Math.min(520, Math.max(200, dragState.leftWidth + deltaX));
        setLeftPanelWidth(next);
        return;
      }

      if (dragState.type === "right") {
        const next = Math.min(620, Math.max(240, dragState.rightWidth - deltaX));
        setRightPanelWidth(next);
      }
    };

    const onMouseUp = () => {
      setDragState(null);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [dragState]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pipelineId = params.get("pipelineId");
    initPipelines(pipelineId);
  }, [initPipelines]);

  useEffect(() => {
    initRuns();
  }, [initRuns]);

  useEffect(() => {
    void getApiClient()
      .getAgents()
      .then(setAgents)
      .catch(() => {
        setAgents(AGENT_DEFINITIONS);
      });
  }, []);

  const runPipeline = useCallback(async () => {
    const snapshot = getActivePipelineSnapshot();

    if (snapshot.nodes.length === 0) {
      pushToast({
        title: "Nothing to run",
        description: "Add at least one agent node before running.",
        tone: "error",
      });
      return;
    }

    if (snapshot.nodes.some((node) => isTriggerAgent(node.data.agentId))) {
      pushToast({
        title: "Manual run disabled",
        description: "Trigger workflows start themselves after the trigger is generated and activated.",
        tone: "info",
      });
      return;
    }

    saveActivePipeline();

    try {
      const runId = await startRun(snapshot);
      pushToast({
        title: "Run started",
        description: `Run ID: ${runId}`,
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "Run failed to start",
        description: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    }
  }, [getActivePipelineSnapshot, pushToast, saveActivePipeline, startRun]);

  const handleSave = useCallback(async () => {
    saveActivePipeline();
    const snapshot = getActivePipelineSnapshot();
    const json = exportActivePipeline();

    try {
      const result = await savePipelineToFile(snapshot, json);
      const api = getApiClient();
      try {
        await api.updatePipeline(snapshot);
      } catch {
        await api.createPipeline(snapshot);
      }

      pushToast({
        title: result.mode === "updated" ? "Workflow file updated" : "Workflow file saved",
        description: `${result.fileName} • synced with gateway`,
        tone: "success",
      });
    } catch (error) {
      if (isUserCanceledFileDialog(error)) {
        return;
      }
      pushToast({
        title: "Save failed",
        description: error instanceof Error ? error.message : "Unable to save workflow file",
        tone: "error",
      });
    }
  }, [exportActivePipeline, getActivePipelineSnapshot, pushToast, saveActivePipeline]);

  const handleInspectorSave = useCallback(() => {
    saveActivePipeline();
    pushToast({
      title: "Workflow settings saved",
      description: "Metadata and workspace path were saved locally.",
      tone: "success",
    });
  }, [pushToast, saveActivePipeline]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTextInput =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true;

      if ((event.key === "Delete" || event.key === "Backspace") && !isTextInput) {
        event.preventDefault();
        deleteSelectedNodes();
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSave();
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void runPipeline();
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelectedNode();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteSelectedNodes, duplicateSelectedNode, handleSave, runPipeline]);

  const addAgentAtPosition = useCallback(
    (agentId: string, position?: XYPosition) => {
      addNodeFromAgent(agentId, position);
    },
    [addNodeFromAgent],
  );

  const handleExport = useCallback(() => {
    try {
      const data = exportActivePipeline();
      const file = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(file);

      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${name.replace(/\s+/g, "-").toLowerCase() || "workflow"}.json`;
      anchor.click();
      URL.revokeObjectURL(url);

      pushToast({
        title: "Workflow exported",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Invalid workflow",
        tone: "error",
      });
    }
  }, [exportActivePipeline, name, pushToast]);

  const handleImportFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      const text = await file.text();

      try {
        importPipelineJson(text);
        pushToast({
          title: "Workflow imported",
          description: file.name,
          tone: "success",
        });
      } catch (error) {
        pushToast({
          title: "Import failed",
          description: error instanceof Error ? error.message : "Invalid file",
          tone: "error",
        });
      } finally {
        event.target.value = "";
      }
    },
    [importPipelineJson, pushToast],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (!instance) {
        return;
      }

      const agentId = event.dataTransfer.getData("application/kovalsky-agent");
      if (!agentId) {
        return;
      }

      const position = instance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      addAgentAtPosition(agentId, position);
    },
    [addAgentAtPosition, instance],
  );

  if (!hydrated || !runHydrated) {
    return <div className="flex h-screen items-center justify-center text-zinc-400">Loading workspace...</div>;
  }

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <TopBar
        pipelineName={name}
        isRunning={Boolean(isRunning)}
        runDisabledReason={runDisabledReason}
        backHref="/pipelines"
        onNameChange={(value) => updateMetadata({ name: value })}
        onRun={() => void runPipeline()}
        onSave={handleSave}
        onExport={handleExport}
        onImport={() => importInputRef.current?.click()}
        onPublish={() => {
          handleExport();
          pushToast({
            title: "Published locally",
            description: "Workflow JSON exported for local sharing.",
            tone: "info",
          });
        }}
        onDuplicateNode={duplicateSelectedNode}
      />

      <div className="border-b border-zinc-800 bg-zinc-900/50 px-3 py-1 text-xs text-zinc-400">
        <span className="text-zinc-300">Workspace: {workspacePath.trim() || "not set"}</span>
      </div>

      <div
        className="grid min-h-0 flex-1"
        style={{
          gridTemplateColumns: `${leftPanelWidth}px 6px minmax(0,1fr) 6px ${rightPanelWidth}px`,
        }}
      >
        <AgentsLibrary agents={agents} onAddAgent={(agentId) => addAgentAtPosition(agentId)} />

        <div
          className="cursor-col-resize bg-zinc-900/40 transition hover:bg-cyan-500/30"
          onMouseDown={(event) =>
            setDragState({
              type: "left",
              startX: event.clientX,
              leftWidth: leftPanelWidth,
              rightWidth: rightPanelWidth,
            })
          }
        />

        <div className="min-h-0" onDrop={handleDrop} onDragOver={(event) => event.preventDefault()}>
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            onInit={setInstance}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onPaneClick={() => {
              setSelection({ nodeId: null, edgeId: null });
              setHandoffNodeId(null);
            }}
            onNodeClick={(_, node) => {
              setSelection({ nodeId: node.id, edgeId: null });
              setHandoffNodeId(null);
            }}
            onEdgeClick={(_, edge) => {
              setSelection({ nodeId: null, edgeId: edge.id });
              setHandoffNodeId(null);
            }}
            onSelectionChange={(selection) => {
              const nodeId = selection.nodes.length === 1 ? selection.nodes[0].id : null;
              const edgeId = selection.edges.length === 1 ? selection.edges[0].id : null;
              setSelection({ nodeId, edgeId });
              if (nodeId !== handoffNodeId) {
                setHandoffNodeId(null);
              }
            }}
            nodeTypes={NODE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            deleteKeyCode={null}
            selectionOnDrag
            panOnDrag
            className="bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950"
          >
            <Background color="#34343a" gap={20} />
            <MiniMap pannable zoomable className="!bg-zinc-900" />
            <Controls className="!border-zinc-700 !bg-zinc-900" />
          </ReactFlow>
        </div>

        <div
          className="cursor-col-resize bg-zinc-900/40 transition hover:bg-cyan-500/30"
          onMouseDown={(event) =>
            setDragState({
              type: "right",
              startX: event.clientX,
              leftWidth: leftPanelWidth,
              rightWidth: rightPanelWidth,
            })
          }
        />

        <InspectorPanel
          pipelineId={activePipelineId}
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          pipeline={{ name, description, tags, workspacePath, chatRerunMode, clearNodeChatContextOnRun }}
          edgeArtifactTypes={edgeArtifactTypes}
          activeRunId={latestRun?.run.id ?? null}
          showHandoff={Boolean(selectedNode && handoffNodeId && selectedNode.id === handoffNodeId)}
          onCloseHandoff={() => setHandoffNodeId(null)}
          onNameChange={setSelectedNodeName}
          onGoalChange={setSelectedNodeGoal}
          onSettingsChange={setSelectedNodeSettings}
          onResetNode={() => {
            setSelectedNodeName("");
            setSelectedNodeGoal("");
            setSelectedNodeSettings({});
          }}
          onDeleteSelectedEdge={() => {
            deleteSelectedEdge();
          }}
          onBeforeSendChat={async () => {
            const snapshot = getActivePipelineSnapshot();
            try {
              await getApiClient().updatePipeline(snapshot);
            } catch {
              // ignore sync errors and let chat call return backend error if any
            }
          }}
          onSavePipeline={handleInspectorSave}
          onSyncPipeline={async () => {
            saveActivePipeline();
            const snapshot = getActivePipelineSnapshot();
            try {
              await getApiClient().updatePipeline(snapshot);
            } catch {
              await getApiClient().createPipeline(snapshot);
            }
          }}
          onExternalRunStarted={(runId) => {
            attachExternalRun(runId, getActivePipelineSnapshot());
          }}
          onMetadataChange={updateMetadata}
        />
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={(event) => void handleImportFile(event)}
      />
    </div>
  );
}

export function CanvasBuilder(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasBuilderInner />
    </ReactFlowProvider>
  );
}
