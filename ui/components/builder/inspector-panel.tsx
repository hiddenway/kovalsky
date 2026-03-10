"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getAgentById, getAgentSettingFields, type AgentSettingField } from "@/lib/agents";
import { getApiClient } from "@/lib/api/client";
import type { PipelineNodeData, ReactFlowEdge, ReactFlowNode } from "@/lib/types";
import { Button } from "@/components/ui/button";

type Props = {
  selectedNode: ReactFlowNode<PipelineNodeData> | null;
  selectedEdge: ReactFlowEdge | null;
  pipeline: {
    name: string;
    description: string;
    tags: string[];
    workspacePath: string;
    chatRerunMode: "node" | "pipeline";
  };
  edgeArtifactTypes: string[];
  activeRunId?: string | null;
  showHandoff: boolean;
  onCloseHandoff: () => void;
  onNameChange: (name: string) => void;
  onGoalChange: (goal: string) => void;
  onSettingsChange: (settings: Record<string, unknown>) => void;
  onResetNode: () => void;
  onDeleteSelectedEdge?: () => void;
  onBeforeSendChat?: () => Promise<void>;
  onSavePipeline: () => void;
  onExternalRunStarted?: (runId: string) => void;
  onMetadataChange: (payload: { name?: string; description?: string; tags?: string[]; workspacePath?: string; chatRerunMode?: "node" | "pipeline" }) => void;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
};

function sanitizeAssistantChatContent(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^step completed successfully\.?$/i.test(line))
    .filter((line) => !/^agent$/i.test(line))
    .filter((line) => !/^you$/i.test(line))
    .filter((line) => !/^post-step report:?$/i.test(line))
    .filter((line) => !/^(mcp:|mcp startup:)/i.test(line))
    .filter((line) => !/^tokens used$/i.test(line))
    .filter((line) => !/^\d[\d\s]{2,}$/.test(line))
    .filter((line) => !/^[-+]\s+[+-]/.test(line))
    .filter((line) => !/^[-+]\s*<\/?[a-z][\w:-]*/i.test(line))
    .filter((line) => !/^diff --git /i.test(line))
    .filter((line) => line.toLowerCase() !== "codex")
    .filter((line) => line.toLowerCase() !== "openclaw")
    .filter((line) => !/^kovalsky_decision:/i.test(line))
    .filter((line) => !/^answer directly and naturally like an assistant/i.test(line))
    .filter((line) => !/^if data is insufficient, ask one concise clarifying question/i.test(line))
    .filter((line) => !/^at the very end add one strict machine-readable line:/i.test(line))
    .filter((line) => !/^use rerun only when the user clearly asks to perform edits\/actions now/i.test(line));

  return lines.join("\n").replace(/^Post-step report:\s*/i, "").trim();
}

function extractUrlsFromText(input: string): string[] {
  const matches = input.match(/https?:\/\/[^\s"'`]+/g) ?? [];
  return Array.from(new Set(matches));
}

function buildAssistantStatus(node: ReactFlowNode<PipelineNodeData>): string {
  const handoff = node.data.handoff;
  if (!handoff) {
    return "Статус: нет данных. Запусти workflow и я сформирую итоговый отчёт.";
  }
  return `Статус: ${handoff.status}\nКоротко: ${handoff.summary || "Шаг завершён."}`;
}

function buildAssistantDetailedReport(node: ReactFlowNode<PipelineNodeData>): string {
  const handoff = node.data.handoff;
  if (!handoff) {
    return "Итоговый отчёт недоступен: шаг ещё не выполнялся.";
  }

  const urls = Array.from(
    new Set([
      ...extractUrlsFromText(handoff.summary),
      ...handoff.comments.flatMap(extractUrlsFromText),
      ...handoff.results.flatMap(extractUrlsFromText),
    ]),
  );

  const comments = handoff.comments.filter((item) => item.trim().length > 0);
  const results = handoff.results.filter((item) => item.trim().length > 0);
  const whatWasDone = handoff.summary.trim() && handoff.summary.trim().toLowerCase() !== "completed successfully"
    ? handoff.summary.trim()
    : (comments[0] ?? "Шаг успешно выполнен, собраны артефакты и итоговые данные.");

  const lines: string[] = [];
  lines.push("Итоговый отчёт:");
  lines.push(`Статус: ${handoff.status}`);
  lines.push("");
  lines.push("Что сделано:");
  lines.push(whatWasDone);
  if (comments.length > 1) {
    lines.push(...comments.slice(1, 5).map((item) => `- ${item}`));
  }
  lines.push("");
  if (urls.length > 0) {
    lines.push("Ссылки:");
    for (const url of urls.slice(0, 5)) {
      lines.push(`- ${url}`);
    }
    lines.push("");
  }
  lines.push("Результаты:");
  if (results.length > 0) {
    for (const result of results.slice(0, 8)) {
      lines.push(`- ${result}`);
    }
  } else {
    lines.push("- Явные артефакты не найдены.");
  }

  return lines.join("\n");
}

function buildFallbackChat(node: ReactFlowNode<PipelineNodeData>): ChatMessage[] {
  return [
    {
      id: `assistant-${node.id}`,
      role: "assistant",
      content: buildAssistantStatus(node),
    },
    {
      id: `assistant-final-${node.id}`,
      role: "assistant",
      content: buildAssistantDetailedReport(node),
    },
  ];
}

function areChatMessagesEqual(left: ChatMessage[], right: ChatMessage[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].id !== right[index].id) {
      return false;
    }
    if (left[index].role !== right[index].role) {
      return false;
    }
    if (left[index].content !== right[index].content) {
      return false;
    }
  }
  return true;
}

export function InspectorPanel({
  selectedNode,
  selectedEdge,
  pipeline,
  edgeArtifactTypes,
  activeRunId,
  showHandoff,
  onCloseHandoff,
  onNameChange,
  onGoalChange,
  onSettingsChange,
  onResetNode,
  onDeleteSelectedEdge,
  onBeforeSendChat,
  onSavePipeline,
  onExternalRunStarted,
  onMetadataChange,
}: Props): React.JSX.Element {
  const selectedNodeId = selectedNode?.id ?? null;
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const chatInitializedForNodeRef = useRef<string | null>(null);
  const externalRunSeenRef = useRef<Set<string>>(new Set());
  const announceExternalRun = useCallback((runId: string, dedupeKey?: string): void => {
    const normalized = runId.trim();
    const normalizedKey = (dedupeKey ?? normalized).trim();
    if (!normalized || !normalizedKey || externalRunSeenRef.current.has(normalizedKey)) {
      return;
    }
    externalRunSeenRef.current.add(normalizedKey);
    onExternalRunStarted?.(normalized);
  }, [onExternalRunStarted]);
  const scrollChatToBottom = (): void => {
    const frame = window.requestAnimationFrame(() => {
      chatBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    });
    window.setTimeout(() => window.cancelAnimationFrame(frame), 800);
  };

  useEffect(() => {
    if (!showHandoff || !selectedNode) {
      return;
    }

    if (chatInitializedForNodeRef.current === selectedNode.id) {
      return;
    }

    chatInitializedForNodeRef.current = selectedNode.id;
    setChatMessages(buildFallbackChat(selectedNode));
    setChatInput("");
    setIsThinking(false);
  }, [selectedNodeId, showHandoff, selectedNode]);

  useEffect(() => {
    if (!showHandoff || !selectedNodeId || !activeRunId) {
      return;
    }

    let disposed = false;
    const api = getApiClient();

    const syncChat = async (): Promise<void> => {
      try {
        const payload = await api.getNodeChat(activeRunId, selectedNodeId);
        if (disposed) {
          return;
        }
        for (const message of payload.messages) {
          if (!message.meta_json) {
            continue;
          }
          try {
            const meta = JSON.parse(message.meta_json) as {
              startedRunId?: unknown;
              rerunDecision?: unknown;
              rerunMode?: unknown;
            };
            if (typeof meta.startedRunId === "string" && meta.startedRunId.trim()) {
              announceExternalRun(meta.startedRunId, `started-run:${message.id}`);
              continue;
            }
            if (meta.rerunDecision === "rerun" && meta.rerunMode === "node" && activeRunId) {
              announceExternalRun(activeRunId, `node-rerun:${message.id}`);
            }
          } catch {
            continue;
          }
        }
        const mapped: ChatMessage[] = payload.messages.reduce<ChatMessage[]>((acc, message) => {
          if (message.role === "system") {
            return acc;
          }
          if (message.role === "user") {
            const content = message.content.trim();
            if (content) {
              acc.push({
                id: message.id,
                role: "user",
                content,
              });
            }
            return acc;
          }

          const cleaned = sanitizeAssistantChatContent(message.content);
          if (!cleaned) {
            return acc;
          }

          acc.push({
            id: message.id,
            role: "assistant",
            content: cleaned,
          });
          return acc;
        }, []);
        const next = mapped.length > 0 ? mapped : (selectedNode ? buildFallbackChat(selectedNode) : []);
        setChatMessages((current) => (areChatMessagesEqual(current, next) ? current : next));
      } catch {
        // Preserve current chat on transient sync errors (e.g. provisional run id before backend run exists).
        // This avoids wiping conversation history when the user starts a new run.
      }
    };

    void syncChat();
    const timer = window.setInterval(() => {
      void syncChat();
    }, 2000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeRunId, selectedNodeId, showHandoff, selectedNode, announceExternalRun]);

  if (selectedNode) {
    const definition = getAgentById(selectedNode.data.agentId);
    const settingFields = getAgentSettingFields(selectedNode.data.agentId);
    const settings = selectedNode.data.settings ?? {};
    const chatContextModeRaw = typeof settings.chatContextMode === "string" ? settings.chatContextMode.trim().toLowerCase() : "";
    const chatContextMode = chatContextModeRaw === "off" || chatContextModeRaw === "strict" ? chatContextModeRaw : "light";

    if (showHandoff) {
      return (
        <aside className="h-full overflow-y-auto border-l border-zinc-800 bg-zinc-950/70 p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Agent Chat</h2>
              <p className="mt-1 text-xs text-zinc-400">
                {definition?.icon ? `${definition.icon} ` : ""}
                {definition?.title ?? selectedNode.data.agentId}
              </p>
            </div>
            <button
              type="button"
              className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition hover:bg-zinc-800"
              onClick={onCloseHandoff}
            >
              Back
            </button>
          </div>

          <div className="mt-3 flex h-[calc(100%-44px)] min-h-[360px] flex-col">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              {chatMessages.map((message) => (
                <div
                  key={message.id}
                  className={
                    message.role === "assistant"
                      ? "rounded-md border border-cyan-500/40 bg-cyan-500/10 p-3 text-sm text-cyan-50"
                      : "rounded-md border border-zinc-700 bg-zinc-900 p-3 text-sm text-zinc-100"
                  }
                >
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-400">
                    {message.role === "assistant" ? "Agent" : "You"}
                  </p>
                  <pre className="whitespace-pre-wrap break-words font-sans">{message.content}</pre>
                </div>
              ))}
              {isThinking ? (
                <div className="rounded-md border border-cyan-500/40 bg-cyan-500/10 p-3 text-sm text-cyan-50">
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-400">Agent</p>
                  <p className="animate-pulse">Thinking...</p>
                </div>
              ) : null}
              <div ref={chatBottomRef} />
            </div>

            <form
              className="mt-3 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const prompt = chatInput.trim();
                if (!prompt) {
                  return;
                }
                if (!selectedNodeId) {
                  return;
                }
                const nodeId = selectedNodeId;

                const userMessage: ChatMessage = {
                  id: `user-${crypto.randomUUID()}`,
                  role: "user",
                  content: prompt,
                };
                setChatMessages((current) => [...current, userMessage]);
                setChatInput("");
                setIsThinking(true);
                scrollChatToBottom();

                void (async () => {
                  if (!activeRunId) {
                    const fallback: ChatMessage = {
                      id: `assistant-${crypto.randomUUID()}`,
                      role: "assistant",
                      content: "Workflow is not running. Start a run first to get an agent follow-up report.",
                    };
                    setChatMessages((current) => [...current, fallback]);
                    setIsThinking(false);
                    return;
                  }

                  try {
                    if (onBeforeSendChat) {
                      await onBeforeSendChat();
                    }
                    const api = getApiClient();
                    const payload = await api.replyNodeChat(activeRunId, nodeId, {
                      content: prompt,
                      rerunMode: pipeline.chatRerunMode,
                    });

                    const assistantMessage: ChatMessage | null = payload.message.role === "user"
                      ? {
                          id: payload.message.id,
                          role: "user",
                          content: payload.message.content.trim(),
                        }
                      : payload.message.role === "system"
                        ? null
                        : (() => {
                            const cleaned = sanitizeAssistantChatContent(payload.message.content);
                            if (!cleaned) {
                              return null;
                            }
                            return {
                              id: payload.message.id,
                              role: "assistant" as const,
                              content: cleaned,
                            };
                          })();

                    setChatMessages((current) => {
                      if (!assistantMessage) {
                        return current;
                      }
                      if (current.some((message) => message.id === assistantMessage.id)) {
                        return current;
                      }
                      return [...current, assistantMessage];
                    });

                    if (payload.message.meta_json) {
                      try {
                        const meta = JSON.parse(payload.message.meta_json) as {
                          startedRunId?: unknown;
                          rerunDecision?: unknown;
                          rerunMode?: unknown;
                        };
                        if (typeof meta.startedRunId === "string" && meta.startedRunId.trim()) {
                          announceExternalRun(meta.startedRunId, `started-run:${payload.message.id}`);
                        } else if (meta.rerunDecision === "rerun" && meta.rerunMode === "node") {
                          announceExternalRun(activeRunId, `node-rerun:${payload.message.id}`);
                        }
                      } catch {
                        // ignore malformed meta
                      }
                    }
                  } catch (error) {
                    const message = error instanceof Error
                      ? error.message
                      : "Failed to send chat message to agent.";
                    setChatMessages((current) => [
                      ...current,
                      {
                        id: `assistant-${crypto.randomUUID()}`,
                        role: "assistant",
                        content: message,
                      },
                    ]);
                  } finally {
                    setIsThinking(false);
                  }
                })();
              }}
            >
              <input
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
                placeholder="Ask for report, links, or summary..."
              />
              <Button type="submit">Send</Button>
            </form>
          </div>
        </aside>
      );
    }

    const readValue = (field: AgentSettingField): boolean | string | number => {
      const value = settings[field.key];
      if (value === undefined || value === null) {
        if (field.defaultValue !== undefined) {
          return field.defaultValue;
        }
        if (field.type === "boolean") {
          return false;
        }
        return "";
      }

      if (field.type === "boolean") {
        return value === true;
      }

      if (field.type === "number") {
        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : (field.defaultValue as number | undefined) ?? 0;
      }

      return String(value);
    };

    const updateSetting = (key: string, value: boolean | string | number): void => {
      onSettingsChange({
        ...settings,
        [key]: value,
      });
    };

    return (
      <aside className="h-full overflow-y-auto border-l border-zinc-800 bg-zinc-950/70 p-3">
        <h2 className="text-sm font-semibold text-zinc-100">Node Inspector</h2>

        <div className="mt-3 space-y-3">
          <div>
            <p className="text-xs text-zinc-400">Agent</p>
            <p className="text-sm text-zinc-200">
              {definition?.icon ? `${definition.icon} ` : ""}
              {definition?.title ?? selectedNode.data.agentId}
            </p>
          </div>

          <div>
            <p className="mb-1 text-xs text-zinc-400">Node Name</p>
            <input
              value={selectedNode.data.customName ?? ""}
              onChange={(event) => onNameChange(event.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
              placeholder="Optional UI-only name"
            />
          </div>

          <div>
            <p className="mb-1 text-xs text-zinc-400">Agent Uses Chat Context</p>
            <select
              value={chatContextMode}
              onChange={(event) =>
                onSettingsChange({
                  ...settings,
                  chatContextMode: event.target.value,
                })}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
            >
              <option value="off">Off</option>
              <option value="light">Light</option>
              <option value="strict">Strict</option>
            </select>
          </div>

          <div>
            <p className="mb-1 text-xs text-zinc-400">Goal</p>
            <textarea
              value={selectedNode.data.goal}
              onChange={(event) => onGoalChange(event.target.value)}
              className="min-h-28 w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
              placeholder="Describe what this agent must do"
            />
          </div>

          <div>
            <p className="mb-1 text-xs text-zinc-400">Settings</p>
            {settingFields.length === 0 ? (
              <p className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400">
                No configurable options for this agent.
              </p>
            ) : (
              <div className="space-y-2">
                {settingFields.map((field) => (
                  <label key={field.key} className="mb-0 grid gap-1 text-xs text-zinc-400">
                    <span>{field.label}</span>
                    {field.type === "boolean" ? (
                      <span className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={Boolean(readValue(field))}
                          onChange={(event) => updateSetting(field.key, event.target.checked)}
                          className="h-4 w-4 accent-cyan-400"
                        />
                        <span className="text-xs text-zinc-300">{field.description ?? "Enable option"}</span>
                      </span>
                    ) : null}
                    {field.type === "text" ? (
                      <input
                        value={String(readValue(field))}
                        onChange={(event) => updateSetting(field.key, event.target.value)}
                        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
                        placeholder={field.placeholder}
                      />
                    ) : null}
                    {field.type === "textarea" ? (
                      <textarea
                        value={String(readValue(field))}
                        onChange={(event) => updateSetting(field.key, event.target.value)}
                        className="min-h-28 w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
                        placeholder={field.placeholder}
                      />
                    ) : null}
                    {field.type === "number" ? (
                      <input
                        type="number"
                        value={Number(readValue(field))}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          updateSetting(field.key, Number.isFinite(next) ? next : Number(field.defaultValue ?? 0));
                        }}
                        min={field.min}
                        step={field.step}
                        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
                      />
                    ) : null}
                    {field.type === "select" ? (
                      <select
                        value={String(readValue(field))}
                        onChange={(event) => updateSetting(field.key, event.target.value)}
                        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
                      >
                        {(field.options ?? []).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    {field.description && field.type !== "boolean" ? (
                      <span className="text-[11px] text-zinc-500">{field.description}</span>
                    ) : null}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onResetNode}>
              Reset
            </Button>
            <Button type="button" variant="secondary" onClick={onSavePipeline}>
              Save
            </Button>
          </div>

        </div>
      </aside>
    );
  }

  if (selectedEdge) {
    return (
      <aside className="h-full overflow-y-auto border-l border-zinc-800 bg-zinc-950/70 p-3">
        <h2 className="text-sm font-semibold text-zinc-100">Edge Inspector</h2>
        <p className="mt-1 text-xs text-zinc-400">
          {selectedEdge.source} → {selectedEdge.target}
        </p>

        <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-900/70 p-3">
          <p className="text-xs text-zinc-400">Passing artifact types (read-only)</p>
          {edgeArtifactTypes.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-zinc-200">
              {edgeArtifactTypes.map((type) => (
                <li key={type}>{type}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">No artifacts recorded yet.</p>
          )}
        </div>

        <div className="mt-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onDeleteSelectedEdge?.()}
            disabled={!onDeleteSelectedEdge}
          >
            Delete Edge
          </Button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="h-full overflow-y-auto border-l border-zinc-800 bg-zinc-950/70 p-3">
      <h2 className="text-sm font-semibold text-zinc-100">Workflow Inspector</h2>

      <div className="mt-3 space-y-3">
        <div>
          <p className="mb-1 text-xs text-zinc-400">Name</p>
          <input
            value={pipeline.name}
            onChange={(event) => onMetadataChange({ name: event.target.value })}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
          />
        </div>

        <div>
          <p className="mb-1 text-xs text-zinc-400">Description</p>
          <textarea
            value={pipeline.description}
            onChange={(event) => onMetadataChange({ description: event.target.value })}
            className="min-h-20 w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
          />
        </div>

        <div>
          <p className="mb-1 text-xs text-zinc-400">Tags (comma-separated)</p>
          <input
            value={pipeline.tags.join(", ")}
            onChange={(event) =>
              onMetadataChange({
                tags: event.target.value
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              })
            }
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
          />
        </div>

        <div>
          <p className="mb-1 text-xs text-zinc-400">Workspace Path</p>
          <input
            value={pipeline.workspacePath}
            onChange={(event) => onMetadataChange({ workspacePath: event.target.value })}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none ring-cyan-400/40 focus:ring"
            placeholder="/absolute/path/to/workspace"
          />
        </div>

        <div>
          <p className="mb-1 text-xs text-zinc-400">When you chat with this agent, rerun:</p>
          <div className="flex gap-2">
            <button
              type="button"
              className={`rounded-md border px-3 py-1 text-xs ${
                pipeline.chatRerunMode === "node"
                  ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100"
                  : "border-zinc-700 bg-zinc-900 text-zinc-300"
              }`}
              onClick={() => onMetadataChange({ chatRerunMode: "node" })}
            >
              Only This Node
            </button>
            <button
              type="button"
              className={`rounded-md border px-3 py-1 text-xs ${
                pipeline.chatRerunMode === "pipeline"
                  ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100"
                  : "border-zinc-700 bg-zinc-900 text-zinc-300"
              }`}
              onClick={() => onMetadataChange({ chatRerunMode: "pipeline" })}
            >
              Entire Workflow
            </button>
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">
            If the agent decides to rerun after your chat message, this controls rerun scope.
          </p>
        </div>

        <Button type="button" variant="secondary" onClick={onSavePipeline} className="w-full">
          Save Settings
        </Button>
      </div>
    </aside>
  );
}
