import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { AgentHost } from "./agent-host";
import { DatabaseService } from "../db";
import { ProcessManager } from "./process-manager";
import { RunService } from "./run-service";
import type { PipelineGraph } from "../types";
import type { RunRecord } from "../types";
import { resolveWorkspacePath } from "../utils/workspace-path";

type TriggerChatRole = "user" | "assistant";

type TriggerChatMessage = {
  role: TriggerChatRole;
  content: string;
};

type TriggerGenerationRequest = {
  nodeId: string;
  goal: string;
  workspacePath: string;
  settings?: Record<string, unknown>;
  messages?: TriggerChatMessage[];
};

type TriggerGeneratedConfig =
  | {
      type: "webhook";
      token: string;
      secret: string;
      method: "GET" | "POST";
      coolDownSeconds: number;
    }
  | {
      type: "script_poll";
      intervalSeconds: number;
      timeoutSeconds: number;
      coolDownSeconds: number;
      scriptFileName: string;
      scriptContent: string;
      scriptPath?: string;
    }
  | {
      type: "agent_poll";
      intervalSeconds: number;
      timeoutSeconds: number;
      coolDownSeconds: number;
      agentPrompt: string;
    };

type TriggerHistoryEntry = {
  id: string;
  at: string;
  content: string;
};

type TriggerGenerationResponse =
  | {
      status: "needs_input";
      questions: string[];
      raw: string;
    }
  | {
      status: "ready";
      summary: string;
      config: TriggerGeneratedConfig;
      scriptPath?: string;
      webhookPath?: string;
      raw: string;
    };

type ActiveWatcher = {
  key: string;
  pipelineId: string;
  nodeId: string;
  goal: string;
  workspacePath: string;
  agentSettings: Record<string, unknown>;
  config: TriggerGeneratedConfig;
  status: "active";
  timer: NodeJS.Timeout | null;
  runningCheck: boolean;
  lastCheckAt: string | null;
  lastFireAt: string | null;
  lastRunId: string | null;
  waitingForRunId: string | null;
  lastError: string | null;
  webhookPath: string | null;
  history: TriggerHistoryEntry[];
};

type TriggerStatusResponse = {
  status: "draft" | "paused" | "active" | "working";
  summary?: string;
  webhookPath?: string | null;
  scriptPath?: string | null;
  lastCheckAt?: string | null;
  lastFireAt?: string | null;
  lastRunId?: string | null;
  lastError?: string | null;
  history?: TriggerHistoryEntry[];
};

const MAX_TRIGGER_QUESTIONS = 5;
const TRIGGER_INPUT_CHANNEL = "KOVALSKY_TRIGGER_INPUT_JSON";
const TRIGGER_INPUT_PREVIEW_MAX_CHARS = 8_000;
const MAX_TRIGGER_PARSE_CHARS = 24_000;
const MAX_TRIGGER_DEEP_PARSE_ATTEMPTS = 40;
const AGENT_POLL_MIN_DELAY_MS = 8_000;

type PollCheckResult = {
  parsed: boolean;
  triggered: boolean;
  reason?: string;
  payload?: Record<string, unknown>;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sanitizeFileName(input: string, fallbackStem: string): string {
  const trimmed = input.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const stem = safe || fallbackStem;
  return stem.endsWith(".mjs") ? stem : `${stem}.mjs`;
}

function sanitizeToken(input: string, fallbackPrefix: string): string {
  const safe = input.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || `${fallbackPrefix}-${randomUUID().slice(0, 8)}`;
}

function ensureArrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => asString(item).trim()).filter(Boolean)
    : [];
}

function normalizeHistoryEntries(value: unknown): TriggerHistoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!isObjectRecord(item)) {
        return null;
      }
      const content = asString(item.content).trim();
      if (!content) {
        return null;
      }
      return {
        id: asString(item.id).trim() || randomUUID(),
        at: asString(item.at).trim() || new Date().toISOString(),
        content,
      } satisfies TriggerHistoryEntry;
    })
    .filter((item): item is TriggerHistoryEntry => Boolean(item));
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const normalized = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const cleaned = normalized.length > MAX_TRIGGER_PARSE_CHARS
    ? normalized.slice(-MAX_TRIGGER_PARSE_CHARS)
    : normalized;

  try {
    const parsed = JSON.parse(cleaned) as unknown;
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    // keep trying below
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    // keep trying below
  }

  const statusMatches = [...cleaned.matchAll(/"status"\s*:\s*"(?:needs_input|ready)"/g)].slice(-3);
  for (const match of statusMatches) {
    const markerIndex = match.index ?? -1;
    if (markerIndex < 0) {
      continue;
    }

    let startIndex = cleaned.lastIndexOf("{", markerIndex);
    let attempts = 0;
    while (startIndex >= 0 && attempts < MAX_TRIGGER_DEEP_PARSE_ATTEMPTS) {
      attempts += 1;
      const candidate = extractBalancedJsonObject(cleaned, startIndex);
      if (candidate) {
        try {
          const parsed = JSON.parse(candidate) as unknown;
          if (isObjectRecord(parsed) && typeof parsed.status === "string") {
            return parsed;
          }
        } catch {
          // continue searching
        }
      }
      startIndex = cleaned.lastIndexOf("{", startIndex - 1);
    }
  }

  return null;
}

function extractBalancedJsonObject(text: string, startIndex: number): string | null {
  if (startIndex < 0 || text[startIndex] !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
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
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
      continue;
    }
  }

  return null;
}

function extractQuestionCandidatesFromRaw(raw: string): string[] {
  const lines = raw
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```"));

  const questions: string[] = [];
  for (const line of lines) {
    const normalized = line
      .replace(/^\d+\.\s+/, "")
      .replace(/^[-*]\s+/, "")
      .trim();
    if (!normalized.includes("?")) {
      continue;
    }
    questions.push(normalized);
  }

  return questions;
}

function extractFatalGenerationError(raw: string): string | null {
  const cleaned = raw.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!cleaned) {
    return null;
  }

  const failoverMatch = cleaned.match(/FailoverError:\s*([^\n]+)/i);
  if (failoverMatch?.[1]) {
    return failoverMatch[1].trim();
  }

  const oauthRefreshMatch = cleaned.match(/OAuth token refresh failed[^\n]*/i);
  if (oauthRefreshMatch?.[0]) {
    return oauthRefreshMatch[0].trim();
  }

  const refreshTokenMatch = cleaned.match(/refresh_token_reused|invalid_request_error/i);
  if (refreshTokenMatch) {
    return "OpenAI Codex OAuth session expired or invalid. Re-authenticate and try again.";
  }

  const apiKeyMatch = cleaned.match(/No API key found for provider|OPENAI_API_KEY/i);
  if (apiKeyMatch) {
    return "Provider credentials are missing. Configure API key or OAuth for the selected model provider.";
  }

  const unsupportedModelMatch = cleaned.match(/model is not supported|Unknown model/i);
  if (unsupportedModelMatch?.[0]) {
    return unsupportedModelMatch[0].trim();
  }

  const hasWebFetch403 =
    /web fetch:[^\n]*failed:[^\n]*\b403\b/i.test(cleaned)
    || /security notice:[\s\S]*external_untrusted_content/i.test(cleaned)
    || /just a moment\.\.\./i.test(cleaned)
    || /cloudflare|attention required|access denied/i.test(cleaned);
  const hasTimeout =
    /embedded run timeout/i.test(cleaned)
    || /timed out \(possible rate limit\)/i.test(cleaned)
    || /request timed out|operation timed out/i.test(cleaned);
  if (hasWebFetch403 && hasTimeout) {
    return "Source website blocked automated fetch (403/anti-bot) and trigger generation timed out. Use webhook/API source, narrower scope, or retry later.";
  }
  if (hasWebFetch403) {
    return "Source website blocked automated fetch (403/anti-bot). Use webhook/API source or a scraping target that allows automated access.";
  }
  if (hasTimeout) {
    return "Trigger generation timed out (possible rate limit or slow external source). Retry with narrower scope or try again later.";
  }

  return null;
}

function normalizeQuestionKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildNeedsInputQuestions(
  messages: TriggerChatMessage[],
  candidateQuestions: string[],
  fallback: string,
): string[] {
  const asked = messages
    .filter((message) => message.role === "assistant")
    .map((message) => normalizeQuestionKey(message.content))
    .filter(Boolean);
  const askedSet = new Set(asked);
  const remaining = Math.max(0, MAX_TRIGGER_QUESTIONS - asked.length);

  if (remaining === 0) {
    return [
      "Question limit reached (5). Provide one precise trigger spec in a single message: source, event condition, webhook or polling, and auth requirements.",
    ];
  }

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const question of candidateQuestions.map((item) => item.trim()).filter(Boolean)) {
    const key = normalizeQuestionKey(question);
    if (!key || askedSet.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(question);
  }

  if (unique.length === 0) {
    const normalizedFallback = normalizeQuestionKey(fallback);
    if (!askedSet.has(normalizedFallback)) {
      unique.push(fallback);
    } else {
      unique.push("Provide one precise trigger spec in a single message: source, event condition, webhook or polling, and auth requirements.");
    }
  }

  return unique.slice(0, remaining);
}

function buildGenerationPrompt(goal: string, messages: TriggerChatMessage[]): string {
  const history = messages.length > 0
    ? messages
        .map((message, index) => `${index + 1}. ${message.role === "assistant" ? "Assistant" : "User"}: ${message.content.trim()}`)
        .join("\n")
    : "No prior chat.";

  return [
    "You design workflow triggers for Kovalsky Gateway.",
    "Goal:",
    goal.trim() || "(empty)",
    "",
    "Chat history:",
    history,
    "",
    "Choose the best trigger approach.",
    "Prefer webhook when an external system can call HTTP.",
    "Otherwise choose script_poll (Node script) or agent_poll (OpenClaw check).",
    "When source analysis requires viewing websites, prioritize browser-based inspection from OpenClaw full profile before plain web fetch.",
    "For script_poll: no dependencies, use global fetch only, print exactly one JSON line.",
    "For agent_poll: define concise check instructions in agentPrompt and still return trigger JSON format.",
    "The JSON line must be either {\"triggered\":true,\"reason\":\"...\"} or {\"triggered\":false}.",
    `Event payload delivery is built-in: downstream workflow agents receive ${TRIGGER_INPUT_CHANNEL} automatically.`,
    "Never ask where to map payload fields inside workflow variables.",
    "If information is insufficient, ask up to 5 short clarifying questions.",
    "Output strict JSON only with one of these shapes:",
    "{\"status\":\"needs_input\",\"questions\":[\"...\"]}",
    "{\"status\":\"ready\",\"summary\":\"...\",\"config\":{\"type\":\"webhook\",\"token\":\"...\",\"secret\":\"...\",\"method\":\"POST\",\"coolDownSeconds\":60}}",
    "{\"status\":\"ready\",\"summary\":\"...\",\"config\":{\"type\":\"script_poll\",\"intervalSeconds\":60,\"timeoutSeconds\":30,\"coolDownSeconds\":60,\"scriptFileName\":\"check-trigger.mjs\",\"scriptContent\":\"...\"}}",
    "{\"status\":\"ready\",\"summary\":\"...\",\"config\":{\"type\":\"agent_poll\",\"intervalSeconds\":60,\"timeoutSeconds\":90,\"coolDownSeconds\":60,\"agentPrompt\":\"...\"}}",
  ].join("\n");
}

function buildAgentPollPrompt(goal: string, agentPrompt: string): string {
  return [
    "You evaluate whether a workflow trigger condition is met right now.",
    `Workflow trigger goal: ${goal.trim() || "(empty)"}`,
    `Trigger check instructions: ${agentPrompt.trim() || "(empty)"}`,
    "Use browser-based inspection when needed.",
    "For TikTok/social feed checks, treat condition as met when the page is open and at least one relevant visible item is present.",
    "Do not require full metadata for every field; if any meaningful visible data is captured, return triggered=true.",
    "Return strict JSON only in one line.",
    "{\"triggered\":true,\"reason\":\"...\"}",
    "or",
    "{\"triggered\":false}",
    "You may include extra JSON fields for downstream workflow payload.",
  ].join("\n");
}

function collectDownstreamNodeIds(graph: PipelineGraph, sourceNodeId: string): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const current = outgoing.get(edge.source) ?? [];
    current.push(edge.target);
    outgoing.set(edge.source, current);
  }

  const visited = new Set<string>();
  const stack = [...(outgoing.get(sourceNodeId) ?? [])];
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (!nodeId || visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);
    for (const next of outgoing.get(nodeId) ?? []) {
      if (!visited.has(next)) {
        stack.push(next);
      }
    }
  }
  return visited;
}

function collectTriggeredExecutionNodeIds(graph: PipelineGraph, triggerNodeId: string): Set<string> {
  const executionNodeIds = collectDownstreamNodeIds(graph, triggerNodeId);
  executionNodeIds.add(triggerNodeId);
  return executionNodeIds;
}

function stringifyTriggerMeta(meta: Record<string, unknown>): string {
  try {
    const compact = JSON.stringify(meta);
    if (!compact) {
      return "{}";
    }
    if (compact.length <= TRIGGER_INPUT_PREVIEW_MAX_CHARS) {
      return JSON.stringify(meta, null, 2);
    }
    const previewLength = Math.max(128, TRIGGER_INPUT_PREVIEW_MAX_CHARS - 256);
    return JSON.stringify(
      {
        truncated: true,
        originalLength: compact.length,
        preview: compact.slice(0, previewLength),
      },
      null,
      2,
    );
  } catch {
    return JSON.stringify({ serializationError: true }, null, 2);
  }
}

function buildTriggerInputBlock(meta: Record<string, unknown>): string {
  return [
    "Trigger runtime input:",
    `Channel: ${TRIGGER_INPUT_CHANNEL}`,
    "This payload came from the event that started the current workflow run.",
    `${TRIGGER_INPUT_CHANNEL}:`,
    stringifyTriggerMeta(meta),
    "Use this payload as authoritative trigger data for this run.",
  ].join("\n");
}

function appendGoalSection(goal: string | undefined, section: string): string {
  const base = (goal ?? "").trim();
  const block = section.trim();
  if (!base) {
    return block;
  }
  if (!block) {
    return base;
  }
  return `${base}\n\n${block}`;
}

function isTransientAgentPollReason(reason: string): boolean {
  const normalized = reason.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized.includes("gateway closed")
    || normalized.includes("gateway unavailable")
    || normalized.includes("browser unavailable")
    || normalized.includes("browser tool unavailable")
    || normalized.includes("eaddrinuse");
}

function isTransientAgentPollError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized.includes("timed out") || isTransientAgentPollReason(normalized);
}

function looksLikeSuccessfulBrowserInspection(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const hardNegativeSignals = [
    "browser unavailable",
    "gateway closed",
    "gateway unavailable",
    "service unavailable",
    "eaddrinuse",
    "timed out",
    "timeout",
    "no data",
    "unable to open",
    "could not open",
    "failed",
    "error",
  ];
  if (hardNegativeSignals.some((token) => normalized.includes(token))) {
    return false;
  }

  const browserSignals = [
    "tiktok",
    "opened",
    "open",
    "video",
    "author",
    "caption",
    "likes",
    "comments",
    "shares",
    "visible",
  ];
  const score = browserSignals.reduce((sum, token) => sum + (normalized.includes(token) ? 1 : 0), 0);
  return score >= 3;
}

export class TriggerService {
  private readonly watchers = new Map<string, ActiveWatcher>();
  private readonly webhookIndex = new Map<string, string>();
  private readonly runtimeDir: string;

  constructor(
    private readonly db: DatabaseService,
    private readonly runService: RunService,
    private readonly agentHost: AgentHost,
    private readonly processManager: ProcessManager,
    appDataDir: string,
    private readonly logger: pino.Logger,
  ) {
    this.runtimeDir = path.join(appDataDir, "trigger-runtime");
  }

  async bootstrapActiveTriggers(): Promise<void> {
    const pipelines = this.db.listPipelines();
    for (const pipeline of pipelines) {
      let graph: PipelineGraph;
      try {
        graph = JSON.parse(pipeline.graph_json) as PipelineGraph;
      } catch {
        continue;
      }

      for (const node of graph.nodes) {
        if (node.agentId !== "trigger") {
          continue;
        }
        const triggerState = this.readTriggerState(node.settings);
        if (triggerState.lifecycleStatus !== "active") {
          continue;
        }

        try {
          await this.activateTrigger({
            pipelineId: pipeline.id,
            nodeId: node.id,
          });
        } catch (error) {
          this.logger.warn(
            { err: error, pipelineId: pipeline.id, nodeId: node.id },
            "failed to bootstrap active trigger",
          );
        }
      }
    }
  }

  async generateTrigger(input: TriggerGenerationRequest): Promise<TriggerGenerationResponse> {
    const workspacePath = resolveWorkspacePath(input.workspacePath);
    if (!workspacePath) {
      const providedPath = (input.workspacePath ?? "").trim();
      if (!providedPath) {
        throw new Error("Workspace path is required to generate a trigger.");
      }
      throw new Error(`Workspace path not found or inaccessible: ${providedPath}`);
    }

    const env = await this.runService.buildAutomationEnv();
    const stepRunId = `trigger-generate-${randomUUID()}`;
    const stepDir = path.join(this.runtimeDir, stepRunId);
    const stepLogPath = path.join(stepDir, "logs.txt");
    fs.mkdirSync(stepDir, { recursive: true });

    const settings = isObjectRecord(input.settings) ? { ...input.settings } : {};
    // Trigger generation should prefer browser-capable OpenClaw profile for site inspection.
    settings.useProfile = true;
    settings.profile = "full";
    const configuredTimeoutSeconds = asNumber(settings.timeoutSeconds);
    settings.timeoutSeconds = Math.max(120, Math.floor(configuredTimeoutSeconds ?? 120));
    settings.reportPromptTemplate = buildGenerationPrompt(input.goal, input.messages ?? []);

    const raw = await this.agentHost.runNodeReport({
      agentId: "trigger",
      context: {
        runId: "trigger-generate",
        stepRunId,
        nodeId: input.nodeId,
        workspacePath,
        stepDir,
        stepLogPath,
        goal: input.goal,
        settings,
        plannedNode: {
          nodeId: input.nodeId,
          agentId: "trigger",
          goal: input.goal,
          receivesFrom: [],
          handoffTo: [],
          notes: [],
        },
        resolvedInputs: {
          inputsByType: {},
          predecessorArtifacts: [],
          handoffs: [],
        },
        env,
        reportMode: true,
        reportContext: {
          reportKind: "chat_followup",
          stepStatus: "success",
          followupPrompt: "Generate trigger configuration",
          chatHistory: (input.messages ?? []).map((message) => ({
            role: message.role === "assistant" ? "agent" : "user",
            content: message.content,
            createdAt: new Date().toISOString(),
          })),
        },
      },
      timeoutMs: 180_000,
    });

    const fatalError = extractFatalGenerationError(raw);
    if (fatalError) {
      throw new Error(`Trigger generation failed: ${fatalError}`);
    }
    const parsed = extractJsonObject(raw);

    if (!parsed) {
      return {
        status: "needs_input",
        questions: buildNeedsInputQuestions(
          input.messages ?? [],
          extractQuestionCandidatesFromRaw(raw),
          "Describe the exact trigger source and event condition.",
        ),
        raw,
      };
    }

    const status = asString(parsed.status).trim().toLowerCase();
    if (status === "needs_input") {
      const questions = ensureArrayOfStrings(parsed.questions).slice(0, MAX_TRIGGER_QUESTIONS);
      return {
        status: "needs_input",
        questions: buildNeedsInputQuestions(
          input.messages ?? [],
          questions.length > 0 ? questions : extractQuestionCandidatesFromRaw(raw),
          "Describe the exact event to monitor for this trigger.",
        ),
        raw,
      };
    }

    const summary = asString(parsed.summary).trim() || "Trigger generated.";
    const configRaw = isObjectRecord(parsed.config) ? parsed.config : {};
    const type = asString(configRaw.type).trim().toLowerCase();

    if (type === "webhook") {
      const token = sanitizeToken(asString(configRaw.token), `trigger-${input.nodeId}`);
      const secret = sanitizeToken(asString(configRaw.secret), `secret-${input.nodeId}`);
      const method = asString(configRaw.method).trim().toUpperCase() === "GET" ? "GET" : "POST";
      const coolDownSeconds = Math.max(5, Math.floor(asNumber(configRaw.coolDownSeconds) ?? 60));

      return {
        status: "ready",
        summary,
        config: {
          type: "webhook",
          token,
          secret,
          method,
          coolDownSeconds,
        },
        webhookPath: `/trigger-hooks/${token}`,
        raw,
      };
    }

    if (type === "agent_poll") {
      const intervalSeconds = Math.max(15, Math.floor(asNumber(configRaw.intervalSeconds) ?? 60));
      const timeoutSeconds = Math.max(15, Math.floor(asNumber(configRaw.timeoutSeconds) ?? 90));
      const coolDownSeconds = Math.max(5, Math.floor(asNumber(configRaw.coolDownSeconds) ?? 60));
      const agentPrompt = asString(configRaw.agentPrompt).trim() || asString(configRaw.prompt).trim();
      if (!agentPrompt) {
        return {
          status: "needs_input",
          questions: buildNeedsInputQuestions(
            input.messages ?? [],
            ["Describe the exact condition the agent should check each polling cycle."],
            "Describe the exact condition the agent should check each polling cycle.",
          ),
          raw,
        };
      }

      return {
        status: "ready",
        summary,
        config: {
          type: "agent_poll",
          intervalSeconds,
          timeoutSeconds,
          coolDownSeconds,
          agentPrompt,
        },
        raw,
      };
    }

    const intervalSeconds = Math.max(15, Math.floor(asNumber(configRaw.intervalSeconds) ?? 60));
    const timeoutSeconds = Math.max(5, Math.floor(asNumber(configRaw.timeoutSeconds) ?? 30));
    const coolDownSeconds = Math.max(5, Math.floor(asNumber(configRaw.coolDownSeconds) ?? 60));
    const scriptFileName = sanitizeFileName(asString(configRaw.scriptFileName), `${input.nodeId}-trigger`);
    const scriptContent = asString(configRaw.scriptContent).trim();
    if (!scriptContent) {
      return {
        status: "needs_input",
        questions: buildNeedsInputQuestions(
          input.messages ?? [],
          ["I need more detail for polling. Describe the exact endpoint, page, or condition the script should check."],
          "Describe the exact endpoint, page, or condition the polling script should check.",
        ),
        raw,
      };
    }

    const scriptPath = this.writeScriptFile(workspacePath, input.nodeId, scriptFileName, scriptContent);
    return {
      status: "ready",
      summary,
      config: {
        type: "script_poll",
        intervalSeconds,
        timeoutSeconds,
        coolDownSeconds,
        scriptFileName,
        scriptContent,
        scriptPath,
      },
      scriptPath,
      raw,
    };
  }

  async activateTrigger(input: {
    pipelineId: string;
    nodeId: string;
  }): Promise<TriggerStatusResponse> {
    const watcherKey = this.toWatcherKey(input.pipelineId, input.nodeId);
    await this.pauseTrigger(input);

    const pipeline = this.db.getPipeline(input.pipelineId);
    if (!pipeline) {
      throw new Error("Workflow not found.");
    }

    const graph = JSON.parse(pipeline.graph_json) as PipelineGraph;
    const node = graph.nodes.find((item) => item.id === input.nodeId);
    if (!node || node.agentId !== "trigger") {
      throw new Error("Trigger node not found.");
    }

    const triggerState = this.readTriggerState(node.settings);
    const workspacePath = resolveWorkspacePath(triggerState.workspacePath);
    if (!workspacePath) {
      throw new Error("Trigger workspace path is missing or invalid.");
    }

    const config = triggerState.generated;
    if (!config) {
      throw new Error("Generate the trigger before activating it.");
    }

    const watcher: ActiveWatcher = {
      key: watcherKey,
      pipelineId: input.pipelineId,
      nodeId: input.nodeId,
      goal: asString(node.goal),
      workspacePath,
      agentSettings: isObjectRecord(node.settings) ? { ...node.settings } : {},
      config,
      status: "active",
      timer: null,
      runningCheck: false,
      lastCheckAt: null,
      lastFireAt: null,
      lastRunId: null,
      waitingForRunId: null,
      lastError: null,
      webhookPath: config.type === "webhook" ? `/trigger-hooks/${config.token}` : null,
      history: triggerState.history ?? [],
    };

    if (config.type !== "webhook") {
      this.scheduleNextPoll(watcher, 0);
    } else {
      this.webhookIndex.set(config.token, watcher.key);
    }

    this.watchers.set(watcher.key, watcher);
    watcher.history.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      content: `Trigger activated (${config.type}).`,
    });
    watcher.history = watcher.history.slice(-20);
    this.appendTriggerHistory(input.pipelineId, input.nodeId, `Trigger activated (${config.type}).`);
    this.persistTriggerState(input.pipelineId, input.nodeId, {
      lifecycleStatus: "active",
      lastError: null,
    });
    return this.buildStatusResponse(watcher, triggerState.summary);
  }

  async pauseTrigger(input: {
    pipelineId: string;
    nodeId: string;
  }): Promise<TriggerStatusResponse> {
    const key = this.toWatcherKey(input.pipelineId, input.nodeId);
    const existing = this.watchers.get(key);
    if (existing) {
      if (existing.timer) {
        clearInterval(existing.timer);
      }
      if (existing.config.type === "webhook") {
        this.webhookIndex.delete(existing.config.token);
      }
      this.watchers.delete(key);
      this.appendTriggerHistory(input.pipelineId, input.nodeId, "Trigger paused.");
      this.persistTriggerState(input.pipelineId, input.nodeId, {
        lifecycleStatus: "paused",
      });
      return this.buildStatusResponse(null, undefined, existing);
    }

    const pipeline = this.db.getPipeline(input.pipelineId);
    if (!pipeline) {
      return { status: "draft" };
    }
    const graph = JSON.parse(pipeline.graph_json) as PipelineGraph;
    const node = graph.nodes.find((item) => item.id === input.nodeId);
    const triggerState = this.readTriggerState(node?.settings);
    const status = triggerState.generated ? "paused" : "draft";
    return {
      status,
      summary: triggerState.summary,
      webhookPath: triggerState.generated?.type === "webhook" ? `/trigger-hooks/${triggerState.generated.token}` : null,
      scriptPath: triggerState.generated?.type === "script_poll" ? triggerState.generated.scriptPath ?? null : null,
      lastError: triggerState.lastError ?? null,
      history: triggerState.history ?? [],
    };
  }

  getTriggerStatus(input: {
    pipelineId: string;
    nodeId: string;
  }): TriggerStatusResponse {
    const watcher = this.watchers.get(this.toWatcherKey(input.pipelineId, input.nodeId));
    if (watcher) {
      return this.buildStatusResponse(watcher);
    }

    const pipeline = this.db.getPipeline(input.pipelineId);
    if (!pipeline) {
      return { status: "draft" };
    }
    const graph = JSON.parse(pipeline.graph_json) as PipelineGraph;
    const node = graph.nodes.find((item) => item.id === input.nodeId);
    const triggerState = this.readTriggerState(node?.settings);
    return {
      status: triggerState.generated ? "paused" : "draft",
      summary: triggerState.summary,
      webhookPath: triggerState.generated?.type === "webhook" ? `/trigger-hooks/${triggerState.generated.token}` : null,
      scriptPath: triggerState.generated?.type === "script_poll" ? triggerState.generated.scriptPath ?? null : null,
      lastError: triggerState.lastError ?? null,
      history: triggerState.history ?? [],
    };
  }

  async handleWebhookFire(input: {
    token: string;
    method: string;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }): Promise<{ ok: boolean; queued: boolean; reason?: string; runId?: string }> {
    const key = this.webhookIndex.get(input.token);
    if (!key) {
      return { ok: false, queued: false, reason: "Trigger not found." };
    }

    const watcher = this.watchers.get(key);
    if (!watcher || watcher.config.type !== "webhook") {
      return { ok: false, queued: false, reason: "Trigger is not active." };
    }

    if (watcher.config.method !== input.method.toUpperCase()) {
      return { ok: false, queued: false, reason: `Use ${watcher.config.method} for this trigger.` };
    }

    const providedSecret = asString(input.headers["x-kovalsky-trigger-secret"]).trim();
    if (providedSecret !== watcher.config.secret) {
      return { ok: false, queued: false, reason: "Invalid trigger secret." };
    }

    const result = await this.fireWatcherWorkflow(watcher, {
      source: "webhook",
      payload: input.body,
    });
    return {
      ok: true,
      queued: Boolean(result.runId),
      reason: result.reason ?? undefined,
      runId: result.runId ?? undefined,
    };
  }

  private async pollWatcher(key: string): Promise<void> {
    const watcher = this.watchers.get(key);
    if (!watcher || watcher.config.type === "webhook" || watcher.runningCheck) {
      return;
    }

    watcher.runningCheck = true;
    watcher.lastCheckAt = new Date().toISOString();
    const cycleStartedAt = Date.now();

    try {
      const inFlightRun = this.getInFlightTriggerRun(watcher);
      if (inFlightRun) {
        if (watcher.waitingForRunId !== inFlightRun.id) {
          watcher.waitingForRunId = inFlightRun.id;
          this.pushWatcherHistory(
            watcher,
            `Workflow run ${inFlightRun.id} is still ${inFlightRun.status}. Trigger checks are paused until it finishes.`,
          );
          this.persistTriggerState(watcher.pipelineId, watcher.nodeId, {
            history: watcher.history,
          });
        }
        return;
      }
      if (watcher.waitingForRunId) {
        this.pushWatcherHistory(
          watcher,
          `Workflow run ${watcher.waitingForRunId} finished. Trigger checks resumed.`,
        );
        watcher.waitingForRunId = null;
        this.persistTriggerState(watcher.pipelineId, watcher.nodeId, {
          history: watcher.history,
        });
      }

      let checkResult: PollCheckResult = { parsed: false, triggered: false };
      let diagnostics: string | null = null;

      if (watcher.config.type === "script_poll") {
        const stdoutLines: string[] = [];
        const stderrLines: string[] = [];
        const scriptPath = watcher.config.scriptPath
          ?? this.writeScriptFile(
            watcher.workspacePath,
            watcher.nodeId,
            watcher.config.scriptFileName,
            watcher.config.scriptContent,
          );

        watcher.config.scriptPath = scriptPath;

        await this.processManager.run({
          key: `trigger:${key}`,
          command: scriptPath,
          args: [],
          cwd: watcher.workspacePath,
          env: {
            ...process.env,
            KOVALSKY_TRIGGER_WORKSPACE_PATH: watcher.workspacePath,
          },
          timeoutMs: watcher.config.timeoutSeconds * 1000,
          onStdout: (line) => {
            stdoutLines.push(line.trim());
          },
          onStderr: (line) => {
            stderrLines.push(line.trim());
          },
        });

        checkResult = this.parsePollOutput(stdoutLines);
        diagnostics = stderrLines.filter(Boolean).slice(-1)[0] ?? null;
      } else if (watcher.config.type === "agent_poll") {
        let lastRaw = "";
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            const raw = await this.runAgentPollCheck(watcher);
            lastRaw = raw;
            checkResult = this.parsePollRaw(raw);
            if (!checkResult.parsed) {
              diagnostics = raw.trim()
                ? `agent_poll output missing JSON decision: ${raw.trim().slice(-240)}`
                : "agent_poll returned empty output.";
              break;
            }

            const reason = asString(checkResult.reason).trim();
            if (!checkResult.triggered && attempt < 2 && isTransientAgentPollReason(reason)) {
              this.pushWatcherHistory(watcher, `Transient browser issue (${reason}). Retrying check once.`);
              await new Promise((resolve) => setTimeout(resolve, 1_500));
              continue;
            }
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : "agent_poll check failed.";
            if (attempt < 2 && isTransientAgentPollError(message)) {
              this.pushWatcherHistory(watcher, `Transient check error (${message}). Retrying check once.`);
              await new Promise((resolve) => setTimeout(resolve, 1_500));
              continue;
            }
            throw error;
          }
        }

        if (!checkResult.parsed && !diagnostics && lastRaw.trim()) {
          diagnostics = `agent_poll output missing JSON decision: ${lastRaw.trim().slice(-240)}`;
        }
        const reason = asString(checkResult.reason).trim().toLowerCase();
        if (
          checkResult.parsed
          && !checkResult.triggered
          && reason === "condition not met"
          && looksLikeSuccessfulBrowserInspection(lastRaw)
        ) {
          checkResult = {
            parsed: true,
            triggered: true,
            reason: "Heuristic override: browser inspection reported visible TikTok data.",
            payload: {
              triggered: true,
              reason: "Heuristic override: browser inspection reported visible TikTok data.",
              heuristic: true,
            },
          };
          this.pushWatcherHistory(
            watcher,
            "Applied heuristic override: treating successful browser inspection as trigger match.",
          );
        }
      } else {
        return;
      }

      if (!checkResult.parsed) {
        watcher.lastError = diagnostics ?? "Trigger check did not return valid JSON decision.";
        this.pushWatcherHistory(watcher, `Check failed: ${watcher.lastError}`);
        this.persistTriggerState(watcher.pipelineId, watcher.nodeId, {
          lastError: watcher.lastError,
          history: watcher.history,
        });
        return;
      }

      if (!checkResult.triggered) {
        const notTriggeredReason = (checkResult.reason ?? "condition not met").trim();
        watcher.lastError = diagnostics ?? (isTransientAgentPollReason(notTriggeredReason) ? notTriggeredReason : null);
        this.pushWatcherHistory(
          watcher,
          watcher.lastError
            ? `Check: not triggered (${notTriggeredReason}). ${watcher.lastError}`
            : `Check: not triggered (${notTriggeredReason}).`,
        );
        this.persistTriggerState(watcher.pipelineId, watcher.nodeId, {
          lastError: watcher.lastError,
          history: watcher.history,
        });
        return;
      }

      const fire = await this.fireWatcherWorkflow(watcher, {
        source: watcher.config.type,
        payload: checkResult.payload ?? {
          triggered: true,
          reason: checkResult.reason ?? `Trigger matched (${watcher.config.type}).`,
        },
      });
      watcher.lastError = fire.reason ?? null;
      if (!fire.runId && fire.reason) {
        this.pushWatcherHistory(watcher, `Trigger matched but run was skipped: ${fire.reason}`);
      }
      this.persistTriggerState(watcher.pipelineId, watcher.nodeId, {
        lastError: watcher.lastError,
        history: watcher.history,
      });
    } catch (error) {
      watcher.lastError = error instanceof Error ? error.message : "Trigger poll failed.";
      this.logger.warn({ err: error, key }, "trigger poll failed");
      this.pushWatcherHistory(watcher, `Check error: ${watcher.lastError}`);
      this.persistTriggerState(watcher.pipelineId, watcher.nodeId, {
        lastError: watcher.lastError,
        history: watcher.history,
      });
    } finally {
      watcher.runningCheck = false;
      const stillActive = this.watchers.get(key);
      if (stillActive && stillActive.config.type !== "webhook") {
        const intervalMs = Math.max(1_000, stillActive.config.intervalSeconds * 1000);
        const elapsedMs = Math.max(0, Date.now() - cycleStartedAt);
        const rawNextDelayMs = Math.max(0, intervalMs - elapsedMs);
        const nextDelayMs = stillActive.config.type === "agent_poll"
          ? Math.max(AGENT_POLL_MIN_DELAY_MS, rawNextDelayMs)
          : rawNextDelayMs;
        this.scheduleNextPoll(stillActive, nextDelayMs);
      }
    }
  }

  private scheduleNextPoll(watcher: ActiveWatcher, delayMs: number): void {
    if (watcher.config.type === "webhook") {
      return;
    }
    if (watcher.timer) {
      clearTimeout(watcher.timer);
    }
    const safeDelayMs = Math.max(0, Math.floor(delayMs));
    watcher.timer = setTimeout(() => {
      watcher.timer = null;
      void this.pollWatcher(watcher.key);
    }, safeDelayMs);
  }

  private parsePollOutput(lines: string[]): PollCheckResult {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) {
        continue;
      }
      if (line === "TRIGGER_FIRED") {
        return {
          parsed: true,
          triggered: true,
          reason: "Trigger script emitted TRIGGER_FIRED.",
          payload: {
            triggered: true,
            reason: "Trigger script emitted TRIGGER_FIRED.",
          },
        };
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isObjectRecord(parsed) && parsed.triggered === true) {
          return {
            parsed: true,
            triggered: true,
            reason: typeof parsed.reason === "string" ? parsed.reason : "Trigger poll reported a match.",
            payload: parsed,
          };
        }
        if (isObjectRecord(parsed) && parsed.triggered === false) {
          return {
            parsed: true,
            triggered: false,
            reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
            payload: parsed,
          };
        }
      } catch {
        continue;
      }
    }

    return { parsed: false, triggered: false };
  }

  private parsePollRaw(raw: string): PollCheckResult {
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const fromLines = this.parsePollOutput(lines);
    if (fromLines.parsed) {
      return fromLines;
    }

    const parsed = extractJsonObject(raw);
    if (!parsed || typeof parsed.triggered !== "boolean") {
      return { parsed: false, triggered: false };
    }

    return {
      parsed: true,
      triggered: parsed.triggered,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      payload: parsed,
    };
  }

  private async runAgentPollCheck(watcher: ActiveWatcher): Promise<string> {
    if (watcher.config.type !== "agent_poll") {
      throw new Error("agent_poll config is required for agent poll checks.");
    }

    const env = await this.runService.buildAutomationEnv();
    const stepRunId = `trigger-agent-poll-${randomUUID()}`;
    const stepDir = path.join(this.runtimeDir, stepRunId);
    const stepLogPath = path.join(stepDir, "logs.txt");
    fs.mkdirSync(stepDir, { recursive: true });

    const timeoutSeconds = Math.max(15, Math.floor(watcher.config.timeoutSeconds));
    const baseSettings = isObjectRecord(watcher.agentSettings) ? { ...watcher.agentSettings } : {};
    const profile = asString(baseSettings.profile).trim() || "full";
    const settings = {
      ...baseSettings,
      useProfile: true,
      profile,
      useIsolatedState: false,
      timeoutSeconds,
      reportPromptTemplate: buildAgentPollPrompt(watcher.goal, watcher.config.agentPrompt),
    };

    return this.agentHost.runNodeReport({
      agentId: "trigger",
      context: {
        runId: `trigger-agent-poll-${watcher.pipelineId}`,
        stepRunId,
        nodeId: watcher.nodeId,
        workspacePath: watcher.workspacePath,
        stepDir,
        stepLogPath,
        goal: watcher.goal,
        settings,
        plannedNode: {
          nodeId: watcher.nodeId,
          agentId: "trigger",
          goal: watcher.goal,
          receivesFrom: [],
          handoffTo: [],
          notes: [],
        },
        resolvedInputs: {
          inputsByType: {},
          predecessorArtifacts: [],
          handoffs: [],
        },
        env,
        reportMode: true,
        reportContext: {
          reportKind: "chat_followup",
          stepStatus: "success",
          followupPrompt: "Check trigger condition and return JSON decision.",
          chatHistory: [],
        },
      },
      timeoutMs: timeoutSeconds * 1000,
    });
  }

  private async fireWatcherWorkflow(
    watcher: ActiveWatcher,
    meta: Record<string, unknown>,
  ): Promise<{ runId: string | null; reason: string | null }> {
    const now = Date.now();
    const inFlightRun = this.getInFlightTriggerRun(watcher);
    if (inFlightRun) {
      watcher.waitingForRunId = inFlightRun.id;
      return {
        runId: null,
        reason: `Workflow run ${inFlightRun.id} is still ${inFlightRun.status}.`,
      };
    }

    const coolDownSeconds = watcher.config.coolDownSeconds;
    if (watcher.lastFireAt) {
      const elapsedMs = now - Date.parse(watcher.lastFireAt);
      if (elapsedMs < coolDownSeconds * 1000) {
        return { runId: null, reason: "Trigger is in cooldown." };
      }
    }

    const pipeline = this.db.getPipeline(watcher.pipelineId);
    if (!pipeline) {
      return { runId: null, reason: "Workflow not found." };
    }

    const graph = JSON.parse(pipeline.graph_json) as PipelineGraph;
    const executionNodeIds = collectTriggeredExecutionNodeIds(graph, watcher.nodeId);
    const downstreamNodeIds = new Set([...executionNodeIds].filter((nodeId) => nodeId !== watcher.nodeId));
    if (downstreamNodeIds.size === 0) {
      return { runId: null, reason: "Trigger fired but no downstream nodes are connected." };
    }
    const triggerInputBlock = buildTriggerInputBlock(meta);
    const graphWithTriggerInput: PipelineGraph = {
      ...graph,
      nodes: graph.nodes
        .filter((node) => executionNodeIds.has(node.id))
        .map((node) => {
          if (!downstreamNodeIds.has(node.id)) {
            return node;
          }
          return {
            ...node,
            goal: appendGoalSection(node.goal, triggerInputBlock),
          };
        }),
      edges: graph.edges.filter((edge) => executionNodeIds.has(edge.source) && executionNodeIds.has(edge.target)),
    };
    const nextStageNodeIds = graphWithTriggerInput.edges
      .filter((edge) => edge.source === watcher.nodeId)
      .map((edge) => graphWithTriggerInput.nodes.find((node) => node.id === edge.target))
      .filter((node): node is NonNullable<typeof node> => Boolean(node))
      .map((node) => node.id);
    const nextStages = nextStageNodeIds
      .map((nodeId) => graphWithTriggerInput.nodes.find((node) => node.id === nodeId))
      .filter((node): node is NonNullable<typeof node> => Boolean(node))
      .map((node) => `${node.agentId}:${node.id}`);
    const started = await this.runService.startRun(watcher.pipelineId, graphWithTriggerInput, {
      workspacePath: watcher.workspacePath,
      clearNodeChatContext: false,
    });

    watcher.lastFireAt = new Date().toISOString();
    watcher.lastRunId = started.runId;
    watcher.waitingForRunId = started.runId;
    watcher.lastError = null;
    const triggerReason = this.extractTriggerReason(meta);
    const historyLines = [
      `Trigger fired: ${triggerReason}`,
      `Workflow run started: ${started.runId}`,
      nextStages.length > 0 ? `Started stages: ${nextStages.join(", ")}` : "Started stages: none",
    ];
    for (const line of historyLines) {
      watcher.history.push({
        id: randomUUID(),
        at: new Date().toISOString(),
        content: line,
      });
    }
    watcher.history = watcher.history.slice(-20);
    this.persistTriggerState(watcher.pipelineId, watcher.nodeId, {
      lifecycleStatus: "active",
      lastFireAt: watcher.lastFireAt,
      lastRunId: watcher.lastRunId,
      lastError: null,
      history: watcher.history,
    });

    this.runService.appendNodeChat({
      runId: started.runId,
      nodeId: watcher.nodeId,
      role: "system",
      phase: "pre_run",
      content: `Trigger fired automatically.\nMeta: ${JSON.stringify(meta)}`,
      meta: {
        source: "trigger_service",
        ...meta,
      },
    });
    for (const nodeId of nextStageNodeIds) {
      this.runService.appendNodeChat({
        runId: started.runId,
        nodeId,
        role: "system",
        phase: "pre_run",
        content: `Triggered by ${watcher.nodeId}.\nMeta: ${JSON.stringify(meta)}`,
        meta: {
          source: "trigger_service",
          triggerNodeId: watcher.nodeId,
          ...meta,
        },
      });
    }

    return { runId: started.runId, reason: null };
  }

  private writeScriptFile(workspacePath: string, nodeId: string, fileName: string, content: string): string {
    const targetDir = path.join(workspacePath, ".kovalsky", "triggers");
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, sanitizeFileName(fileName, nodeId));
    fs.writeFileSync(targetPath, `${content.trim()}\n`, "utf8");
    return targetPath;
  }

  private readTriggerState(settings: Record<string, unknown> | undefined): {
    lifecycleStatus: "draft" | "paused" | "active";
    summary?: string;
    workspacePath?: string;
    generated?: TriggerGeneratedConfig;
    history?: TriggerHistoryEntry[];
    lastError?: string | null;
  } {
    const trigger = isObjectRecord(settings?.trigger) ? settings.trigger : {};
    const lifecycleRaw = asString(trigger.lifecycleStatus).trim().toLowerCase();
    const lifecycleStatus = lifecycleRaw === "active" || lifecycleRaw === "paused" ? lifecycleRaw : "draft";
    const summary = asString(trigger.summary).trim() || undefined;
    const workspacePath = asString(trigger.workspacePath).trim() || undefined;
    const generated = this.normalizeGeneratedConfig(trigger.generated);
    return {
      lifecycleStatus,
      summary,
      workspacePath,
      generated,
      history: normalizeHistoryEntries(trigger.history),
      lastError: asString(trigger.lastError).trim() || null,
    };
  }

  private normalizeGeneratedConfig(value: unknown): TriggerGeneratedConfig | undefined {
    if (!isObjectRecord(value)) {
      return undefined;
    }

    const type = asString(value.type).trim().toLowerCase();
    if (type === "webhook") {
      return {
        type: "webhook",
        token: sanitizeToken(asString(value.token), "trigger"),
        secret: sanitizeToken(asString(value.secret), "secret"),
        method: asString(value.method).trim().toUpperCase() === "GET" ? "GET" : "POST",
        coolDownSeconds: Math.max(5, Math.floor(asNumber(value.coolDownSeconds) ?? 60)),
      };
    }

    if (type === "script_poll") {
      const scriptContent = asString(value.scriptContent).trim();
      if (!scriptContent) {
        return undefined;
      }
      return {
        type: "script_poll",
        intervalSeconds: Math.max(15, Math.floor(asNumber(value.intervalSeconds) ?? 60)),
        timeoutSeconds: Math.max(5, Math.floor(asNumber(value.timeoutSeconds) ?? 30)),
        coolDownSeconds: Math.max(5, Math.floor(asNumber(value.coolDownSeconds) ?? 60)),
        scriptFileName: sanitizeFileName(asString(value.scriptFileName), "trigger"),
        scriptContent,
        scriptPath: asString(value.scriptPath).trim() || undefined,
      };
    }

    if (type === "agent_poll") {
      const agentPrompt = asString(value.agentPrompt).trim() || asString(value.prompt).trim();
      if (!agentPrompt) {
        return undefined;
      }
      return {
        type: "agent_poll",
        intervalSeconds: Math.max(15, Math.floor(asNumber(value.intervalSeconds) ?? 60)),
        timeoutSeconds: Math.max(15, Math.floor(asNumber(value.timeoutSeconds) ?? 90)),
        coolDownSeconds: Math.max(5, Math.floor(asNumber(value.coolDownSeconds) ?? 60)),
        agentPrompt,
      };
    }

    return undefined;
  }

  private buildStatusResponse(
    watcher: ActiveWatcher | null,
    summary?: string,
    previousWatcher?: ActiveWatcher,
  ): TriggerStatusResponse {
    const source = watcher ?? previousWatcher ?? null;
    if (!source) {
      return { status: "draft", summary };
    }

    return {
      status: watcher ? (watcher.runningCheck ? "working" : "active") : "paused",
      summary,
      webhookPath: source.webhookPath,
      scriptPath: source.config.type === "script_poll" ? source.config.scriptPath ?? null : null,
      lastCheckAt: source.lastCheckAt,
      lastFireAt: source.lastFireAt,
      lastRunId: source.lastRunId,
      lastError: source.lastError,
      history: source.history,
    };
  }

  private toWatcherKey(pipelineId: string, nodeId: string): string {
    return `${pipelineId}:${nodeId}`;
  }

  private getInFlightTriggerRun(watcher: ActiveWatcher): RunRecord | null {
    const runId = watcher.lastRunId?.trim();
    if (!runId) {
      return null;
    }
    const run = this.db.getRun(runId);
    if (!run) {
      return null;
    }
    if (run.status === "queued" || run.status === "running") {
      return run;
    }
    return null;
  }

  private pushWatcherHistory(watcher: ActiveWatcher, content: string): void {
    const normalized = content.trim();
    if (!normalized) {
      return;
    }
    watcher.history.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      content: normalized,
    });
    watcher.history = watcher.history.slice(-20);
  }

  private appendTriggerHistory(pipelineId: string, nodeId: string, content: string): void {
    const pipeline = this.db.getPipeline(pipelineId);
    if (!pipeline) {
      return;
    }
    const graph = JSON.parse(pipeline.graph_json) as PipelineGraph;
    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node) {
      return;
    }
    const settings = isObjectRecord(node.settings) ? { ...node.settings } : {};
    const trigger = isObjectRecord(settings.trigger) ? { ...settings.trigger } : {};
    const history = normalizeHistoryEntries(trigger.history);
    history.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      content,
    });
    trigger.history = history.slice(-20);
    settings.trigger = trigger;
    node.settings = settings;
    this.db.updatePipeline(pipeline.id, pipeline.name, JSON.stringify(graph));
  }

  private persistTriggerState(pipelineId: string, nodeId: string, patch: Record<string, unknown>): void {
    const pipeline = this.db.getPipeline(pipelineId);
    if (!pipeline) {
      return;
    }
    const graph = JSON.parse(pipeline.graph_json) as PipelineGraph;
    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node) {
      return;
    }
    const settings = isObjectRecord(node.settings) ? { ...node.settings } : {};
    const trigger = isObjectRecord(settings.trigger) ? { ...settings.trigger } : {};
    settings.trigger = {
      ...trigger,
      ...patch,
    };
    node.settings = settings;
    this.db.updatePipeline(pipeline.id, pipeline.name, JSON.stringify(graph));
  }

  private extractTriggerReason(meta: Record<string, unknown>): string {
    const payload = isObjectRecord(meta.payload) ? meta.payload : null;
    const reason = payload ? asString(payload.reason).trim() : "";
    if (reason) {
      return reason;
    }
    const source = asString(meta.source).trim();
    return source ? `source=${source}` : "source=unknown";
  }
}
