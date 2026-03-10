// @ts-nocheck
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  Background,
  Connection,
  Controls,
  default as ReactFlow,
  Edge,
  Handle,
  MiniMap,
  Node,
  NodeProps,
  Position,
  useEdgesState,
  useNodesState,
} from "reactflow";
import "reactflow/dist/style.css";
import { GatewayApi } from "@/lib/gateway-api";
import { loadPreferences, savePreferences } from "@/lib/local-state";
import type { RunSnapshot } from "@/types/gateway";

interface StudioNodeData {
  title: string;
  agentId: string;
  goal: string;
  settingsText: string;
  [key: string]: unknown;
}

type AgentNode = Node<StudioNodeData>;

const starterNodes: AgentNode[] = [
  {
    id: "n1",
    type: "agent",
    position: { x: 40, y: 180 },
    data: {
      title: "AGENT 1",
      agentId: "codex-cli",
      goal: "Build a browser-based snake-style game",
      settingsText: JSON.stringify(
        {
          command: "codex",
          args: ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"],
          passGoalAsArg: true,
          dangerouslyBypassSandbox: true,
        },
        null,
        2,
      ),
    },
  },
  {
    id: "n2",
    type: "agent",
    position: { x: 400, y: 180 },
    data: {
      title: "AGENT 2",
      agentId: "codex-cli",
      goal: "Write unit tests for all new commits when needed",
      settingsText: JSON.stringify(
        {
          command: "codex",
          args: ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"],
          passGoalAsArg: true,
          dangerouslyBypassSandbox: true,
          outputUrlFile: "kovalsky.url",
        },
        null,
        2,
      ),
    },
  },
  {
    id: "n3",
    type: "agent",
    position: { x: 760, y: 180 },
    data: {
      title: "AGENT 3",
      agentId: "openclaw",
      goal: "Perform black-box browser testing for the game",
      settingsText: JSON.stringify(
        {
          command: "openclaw",
          args: [],
          profile: "full",
        },
        null,
        2,
      ),
    },
  },
];

const starterEdges: Edge[] = [
  { id: "e1", source: "n1", target: "n2" },
  { id: "e2", source: "n2", target: "n3" },
];

function parseSettings(text: string): { value: Record<string, unknown>; error: string | null } {
  if (!text.trim()) {
    return { value: {}, error: null };
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: {}, error: "Settings JSON must be an object" };
    }
    return { value: parsed, error: null };
  } catch {
    return { value: {}, error: "Settings JSON is invalid" };
  }
}

function AgentCardNode({ data, selected }: NodeProps<AgentNode>) {
  return (
    <div className={`agent-node ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Left} className="rf-handle" />
      <div className="agent-node-top">PLAY</div>
      <div className="agent-node-goal">{data.goal || "Goal is empty"}</div>
      <div className="agent-node-bottom">
        <div>{data.title}</div>
        <div className="mono">{data.agentId}</div>
      </div>
      <Handle type="source" position={Position.Right} className="rf-handle" />
    </div>
  );
}

const nodeTypes = {
  agent: AgentCardNode,
};

function statusClass(status: string | undefined): string {
  if (!status) return "badge";
  if (status === "success") return "badge success";
  if (status === "failed") return "badge failed";
  if (status === "running") return "badge running";
  if (status === "canceled") return "badge canceled";
  return "badge";
}

export function GatewayStudio() {
  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNode>(starterNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(starterEdges);

  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8787");
  const [token, setToken] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");

  const [pipelineName, setPipelineName] = useState("Workflow Example");
  const [pipelineId, setPipelineId] = useState("");
  const [runId, setRunId] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string>(starterNodes[0].id);

  const [agents, setAgents] = useState<Array<{ id: string; title: string }>>([]);
  const [runSnapshot, setRunSnapshot] = useState<RunSnapshot | null>(null);
  const [chatMessages, setChatMessages] = useState<
    Array<{
      id: string;
      role: string;
      phase: string;
      content: string;
      createdAt: string;
    }>
  >([]);
  const [nodeLogLines, setNodeLogLines] = useState<string[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [streamActive, setStreamActive] = useState(false);
  const [artifactPreview, setArtifactPreview] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState<string>("");

  const socketRef = useRef<WebSocket | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const prefs = loadPreferences();
    setBaseUrl(prefs.baseUrl);
    setToken(prefs.token);
    setWorkspacePath(prefs.workspacePath || "");
  }, []);

  useEffect(() => {
    savePreferences({ baseUrl, token, workspacePath });
  }, [baseUrl, token, workspacePath]);

  const api = useMemo(() => new GatewayApi(baseUrl, token), [baseUrl, token]);

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);
  const selectedStepRun = useMemo(() => {
    if (!runSnapshot || !selectedNodeId) {
      return null;
    }
    const candidates = runSnapshot.stepRuns.filter((step) => step.node_id === selectedNodeId);
    if (candidates.length === 0) {
      return null;
    }
    return candidates[candidates.length - 1];
  }, [runSnapshot, selectedNodeId]);

  const setNodeData = useCallback(
    (nodeId: string, patch: Partial<StudioNodeData>) => {
      setNodes((prev) =>
        prev.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  ...patch,
                },
              }
            : node,
        ),
      );
    },
    [setNodes],
  );

  const buildGraphPayload = useCallback(() => {
    const parsedNodes = nodes.map((node) => {
      const parsed = parseSettings(node.data.settingsText);
      if (parsed.error) {
        throw new Error(`Node ${node.id}: ${parsed.error}`);
      }

      return {
        id: node.id,
        agentId: node.data.agentId,
        goal: node.data.goal,
        settings: parsed.value,
        position: {
          x: node.position.x,
          y: node.position.y,
        },
      };
    });

    const parsedEdges = edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    }));

    return {
      nodes: parsedNodes,
      edges: parsedEdges,
    };
  }, [edges, nodes]);

  const runAction = useCallback(
    async <T,>(key: string, action: () => Promise<T>): Promise<T | null> => {
      setBusy(key);
      setError("");
      try {
        return await action();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unexpected error");
        return null;
      } finally {
        setBusy("");
      }
    },
    [],
  );

  const loadAgents = useCallback(async () => {
    const result = await runAction("agents", () => api.listAgents());
    if (!result) return;
    setAgents(result.map((item) => ({ id: item.id, title: item.title })));
  }, [api, runAction]);

  const createPipeline = useCallback(async () => {
    const payload = buildGraphPayload();
    const result = await runAction("createPipeline", () => api.createPipeline({ name: pipelineName, graph: payload }));
    if (!result) return;
    setPipelineId(result.pipelineId);
  }, [api, buildGraphPayload, pipelineName, runAction]);

  const updatePipeline = useCallback(async () => {
    if (!pipelineId) {
      setError("Workflow ID is empty");
      return;
    }
    const payload = buildGraphPayload();
    await runAction("updatePipeline", () => api.updatePipeline(pipelineId, { name: pipelineName, graph: payload }));
  }, [api, buildGraphPayload, pipelineId, pipelineName, runAction]);

  const loadPipeline = useCallback(async () => {
    if (!pipelineId) {
      setError("Workflow ID is empty");
      return;
    }

    const result = await runAction("loadPipeline", () => api.getPipeline(pipelineId));
    if (!result) return;

    setPipelineName(result.name);
    const nextNodes = result.graph.nodes.map<AgentNode>((node, index) => {
      const settings = { ...(node.settings ?? {}) } as Record<string, unknown>;

      return {
        id: node.id,
        type: "agent",
        position: node.position ?? { x: 60 + index * 260, y: 180 },
        data: {
          title: `AGENT ${index + 1}`,
          agentId: node.agentId,
          goal: node.goal ?? "",
          settingsText: JSON.stringify(settings, null, 2),
        },
      };
    });

    const nextEdges = result.graph.edges.map<Edge>((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    }));

    setNodes(nextNodes);
    setEdges(nextEdges);
    setSelectedNodeId(nextNodes[0]?.id ?? "");
  }, [api, pipelineId, runAction, setEdges, setNodes]);

  const refreshRun = useCallback(async () => {
    if (!runId) return;

    const result = await runAction("refreshRun", () => api.getRun(runId));
    if (!result) return;
    setRunSnapshot(result);
  }, [api, runAction, runId]);

  const startRun = useCallback(async () => {
    if (!pipelineId) {
      setError("Create or load workflow first");
      return;
    }

    const result = await runAction("startRun", () =>
      api.startRun({
        pipelineId,
        overrides: {
          workspacePath,
          credentialId: credentialId.trim() || undefined,
        },
      }),
    );

    if (!result) return;
    setRunId(result.runId);
  }, [api, credentialId, pipelineId, runAction, workspacePath]);

  const cancelRun = useCallback(async () => {
    if (!runId) return;
    await runAction("cancelRun", () => api.cancelRun(runId));
    await refreshRun();
  }, [api, refreshRun, runAction, runId]);

  const loadChat = useCallback(async () => {
    if (!runId || !selectedNodeId) {
      setChatMessages([]);
      return;
    }

    const result = await runAction("loadChat", () => api.getNodeChat(runId, selectedNodeId));
    if (!result) return;

    setChatMessages(
      result.messages.map((message) => ({
        id: message.id,
        role: message.role,
        phase: message.phase,
        content: message.content,
        createdAt: message.created_at,
      })),
    );
  }, [api, runAction, runId, selectedNodeId]);

  const loadNodeLogs = useCallback(async () => {
    if (!runId || !selectedStepRun?.id) {
      setNodeLogLines([]);
      return;
    }

    const result = await runAction("loadNodeLogs", () => api.getStepLogs(runId, selectedStepRun.id, 260));
    if (!result) return;
    setNodeLogLines(result.lines);
  }, [api, runAction, runId, selectedStepRun]);

  const sendChatMessage = useCallback(async () => {
    if (!runId || !selectedNodeId || !chatInput.trim()) return;

    const result = await runAction("sendChat", () =>
      api.appendNodeChat({
        runId,
        nodeId: selectedNodeId,
        content: chatInput.trim(),
        role: "user",
        phase: "run",
      }),
    );

    if (!result) return;
    setChatInput("");
    await loadChat();
  }, [api, chatInput, loadChat, runId, runAction, selectedNodeId]);

  const openArtifact = useCallback(
    async (artifactId: string) => {
      const result = await runAction("artifactPreview", () => api.getArtifactPreview(artifactId));
      if (!result) return;
      setArtifactPreview(result.preview);
    },
    [api, runAction],
  );

  const connectStream = useCallback(() => {
    if (!runId) {
      setError("Run ID is empty");
      return;
    }

    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }

    const socket = api.connectRunStream(runId, (event) => {
      const shouldRefresh = [
        "step_status",
        "run_status",
        "artifact_created",
        "plan_finalized",
        "chat_message",
      ].includes(event.type);

      if (shouldRefresh) {
        if (refreshTimerRef.current) {
          window.clearTimeout(refreshTimerRef.current);
        }
        refreshTimerRef.current = window.setTimeout(() => {
          void refreshRun();
          void loadChat();
          void loadNodeLogs();
        }, 250);
      }
    });

    socket.onopen = () => setStreamActive(true);
    socket.onclose = () => {
      setStreamActive(false);
      socketRef.current = null;
    };
    socket.onerror = () => {
      setStreamActive(false);
      setError("Stream connection failed");
    };

    socketRef.current = socket;
  }, [api, loadChat, loadNodeLogs, refreshRun, runId]);

  const disconnectStream = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    setStreamActive(false);
  }, []);

  useEffect(() => {
    void refreshRun();
  }, [refreshRun]);

  useEffect(() => {
    void loadChat();
  }, [loadChat]);

  useEffect(() => {
    void loadNodeLogs();
  }, [loadNodeLogs]);

  useEffect(() => {
    if (!token.trim()) return;
    void loadAgents();
  }, [loadAgents, token]);

  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.close();
      }
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    setEdges((oldEdges) => addEdge({ ...connection, id: `e-${Date.now()}` }, oldEdges));
  }, [setEdges]);

  const addNode = useCallback(() => {
    const next = nodes.length + 1;
    const id = `n${next}-${Date.now().toString(36).slice(-4)}`;
    const newNode: AgentNode = {
      id,
      type: "agent",
      position: { x: 80 + next * 60, y: 120 + next * 35 },
      data: {
        title: `AGENT ${next}`,
        agentId: agents[0]?.id ?? "codex-cli",
        goal: "",
        settingsText: "{}",
      },
    };
    setNodes((prev) => [...prev, newNode]);
    setSelectedNodeId(id);
  }, [agents, nodes.length, setNodes]);

  const removeNode = useCallback(() => {
    if (!selectedNodeId) return;
    setNodes((prev) => prev.filter((node) => node.id !== selectedNodeId));
    setEdges((prev) => prev.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId("");
  }, [selectedNodeId, setEdges, setNodes]);

  return (
    <main className="studio-root">
      <section className="hero">
        <div>
          <h1>Kovalsky Gateway Studio</h1>
          <p>
            Goal + chat per agent node. Handoff context is built directly from the graph without a planner.
          </p>
        </div>
        <div className="status-chip-wrap">
          <span className={statusClass(runSnapshot?.run?.status)}>run: {runSnapshot?.run?.status ?? "idle"}</span>
          <span className={`badge ${streamActive ? "running" : ""}`}>stream: {streamActive ? "connected" : "off"}</span>
          <span className="badge mono">runId: {runId || "-"}</span>
        </div>
      </section>

      <section className="controls-grid">
        <div className="panel">
          <h2>Gateway</h2>
          <label>
            API Base URL
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
          <label>
            Pairing Token
            <input value={token} onChange={(event) => setToken(event.target.value)} />
          </label>
          <label>
            Workspace Path
            <input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} />
          </label>
        </div>

        <div className="panel">
          <h2>Workflow</h2>
          <label>
            Workflow Name
            <input value={pipelineName} onChange={(event) => setPipelineName(event.target.value)} />
          </label>
          <label>
            Workflow ID
            <input value={pipelineId} onChange={(event) => setPipelineId(event.target.value)} />
          </label>
          <div className="btn-row">
            <button onClick={createPipeline} disabled={!!busy || !token}>Create</button>
            <button onClick={updatePipeline} disabled={!!busy || !token || !pipelineId}>Update</button>
            <button onClick={loadPipeline} disabled={!!busy || !token || !pipelineId}>Load</button>
          </div>
        </div>

        <div className="panel">
          <h2>Run</h2>
          <label>
            Run ID
            <input value={runId} onChange={(event) => setRunId(event.target.value)} />
          </label>
          <label>
            Credential ID (optional)
            <input value={credentialId} onChange={(event) => setCredentialId(event.target.value)} />
          </label>
          <div className="btn-row">
            <button onClick={startRun} disabled={!!busy || !token || !pipelineId}>Play</button>
            <button onClick={cancelRun} disabled={!!busy || !token || !runId}>Cancel</button>
            <button onClick={refreshRun} disabled={!!busy || !token || !runId}>Refresh</button>
          </div>
          <div className="btn-row">
            <button onClick={connectStream} disabled={!!busy || !token || !runId || streamActive}>Connect Stream</button>
            <button onClick={disconnectStream} disabled={!streamActive}>Disconnect</button>
          </div>
        </div>
      </section>

      {error ? <div className="error-box">{error}</div> : null}

      <section className="workspace-grid">
        <div className="panel canvas-panel">
          <div className="panel-title-row">
            <h2>Graph</h2>
            <div className="btn-row compact">
              <button onClick={addNode}>Add Node</button>
              <button onClick={removeNode} disabled={!selectedNodeId}>Remove Selected</button>
            </div>
          </div>
          <div className="graph-canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => setSelectedNodeId(node.id)}
              fitView
              nodeTypes={nodeTypes}
            >
              <Background color="#d7c7aa" gap={22} />
              <Controls position="top-left" />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </div>
        </div>

        <div className="panel side-panel">
          <h2>Node Goal & Chat</h2>
          {selectedNode ? (
            <>
              <label>
                Node title
                <input
                  value={selectedNode.data.title}
                  onChange={(event) => setNodeData(selectedNode.id, { title: event.target.value })}
                />
              </label>
              <label>
                Agent
                <select
                  value={selectedNode.data.agentId}
                  onChange={(event) => setNodeData(selectedNode.id, { agentId: event.target.value })}
                >
                  {agents.length === 0 ? <option value={selectedNode.data.agentId}>{selectedNode.data.agentId}</option> : null}
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.id} | {agent.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Goal
                <textarea
                  value={selectedNode.data.goal}
                  onChange={(event) => setNodeData(selectedNode.id, { goal: event.target.value })}
                />
              </label>

              <label>
                Settings JSON
                <textarea
                  value={selectedNode.data.settingsText}
                  onChange={(event) => setNodeData(selectedNode.id, { settingsText: event.target.value })}
                />
              </label>

              <div className="chat-block">
                <div className="chat-head">
                  <h3>Chat history</h3>
                  <button onClick={loadChat} disabled={!!busy || !runId}>Reload</button>
                </div>
                <div className="chat-list">
                  {chatMessages.map((message) => (
                    <article key={message.id} className={`chat-item ${message.role}`}>
                      <header>
                        <span className="mono">{message.role}</span>
                        <span className="mono">{message.phase}</span>
                      </header>
                      <p>{message.content}</p>
                    </article>
                  ))}
                </div>
                <div className="chat-input-row">
                  <textarea
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    placeholder="Send instruction/message to this node chat"
                  />
                  <button onClick={sendChatMessage} disabled={!!busy || !runId || !chatInput.trim()}>
                    Send
                  </button>
                </div>
              </div>

              <div className="chat-block">
                <div className="chat-head">
                  <h3>Node Logs</h3>
                  <button onClick={loadNodeLogs} disabled={!!busy || !runId || !selectedStepRun?.id}>Reload</button>
                </div>
                <p className="mono small">stepRunId: {selectedStepRun?.id ?? "-"}</p>
                <div className="events-list mono">
                  {selectedStepRun ? (
                    nodeLogLines.length > 0 ? (
                      nodeLogLines.map((line, index) => <div key={`${selectedStepRun.id}-${index}`}>{line}</div>)
                    ) : (
                      <div>No logs yet for this step.</div>
                    )
                  ) : (
                    <div>This node has no step run yet.</div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <p>Select a node.</p>
          )}
        </div>
      </section>

      <section className="workspace-grid">
        <div className="panel">
          <h2>Run Plan</h2>
          {runSnapshot?.plan ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Node</th>
                    <th>Agent</th>
                    <th>Receives From</th>
                    <th>Handoff To</th>
                    <th>Launch Hints</th>
                  </tr>
                </thead>
                <tbody>
                  {runSnapshot.plan.nodes.map((item) => (
                    <tr key={item.nodeId}>
                      <td>{item.nodeId}</td>
                      <td>{item.agentId}</td>
                      <td>{item.receivesFrom.join(", ") || "-"}</td>
                      <td>{item.handoffTo.map((target) => target.nodeId).join(", ") || "-"}</td>
                      <td className="mono small">
                        {item.handoffTo.flatMap((target) => target.launchHints).join(" | ") || "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No plan yet.</p>
          )}
          {runSnapshot?.plan?.issues?.length ? (
            <div className="issues-list">
              {runSnapshot.plan.issues.map((issue, idx) => (
                <div key={`${issue.nodeId}-${idx}`} className={`issue ${issue.severity}`}>
                  <strong>{issue.severity.toUpperCase()}</strong> {issue.nodeId} / {issue.inputType}: {issue.message}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="panel">
          <h2>Step Runs & Artifacts</h2>
          <div className="step-list">
            {(runSnapshot?.stepRuns ?? []).map((step) => (
              <div key={step.id} className="step-item">
                <span className="mono">{step.node_id}</span>
                <span className={statusClass(step.status)}>{step.status}</span>
              </div>
            ))}
          </div>
          <div className="artifact-list">
            {(runSnapshot?.artifacts ?? []).map((artifact) => (
              <button key={artifact.id} className="artifact-item" onClick={() => void openArtifact(artifact.id)}>
                <span>{artifact.type}</span>
                <span className="mono">{artifact.title}</span>
              </button>
            ))}
          </div>
          <pre className="preview mono">{artifactPreview || "Artifact preview will be shown here."}</pre>
        </div>
      </section>

    </main>
  );
}
