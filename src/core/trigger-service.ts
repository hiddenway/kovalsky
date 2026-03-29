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
const TRIGGER_EVENT_DATA_CHANNEL = "KOVALSKY_TRIGGER_EVENT_DATA_JSON";
const TRIGGER_INPUT_PREVIEW_MAX_CHARS = 8_000;
const MAX_TRIGGER_PARSE_CHARS = 120_000;
const MAX_TRIGGER_DEEP_PARSE_ATTEMPTS = 40;
const AGENT_POLL_MIN_DELAY_MS = 8_000;
const QUIET_NOT_TRIGGERED_REASONS = new Set([
  "no_new_private_text",
  "no new private text message",
  "no new private text messages",
  "no new private text messages for telegram trigger",
]);

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

function summarizeScriptPollDiagnostics(lines: string[]): string | null {
  const cleaned = lines
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
    .filter(Boolean);
  if (cleaned.length === 0) {
    return null;
  }

  const withoutNodeVersion = cleaned.filter((line) => !/^Node\.js v\d+/i.test(line));
  const source = withoutNodeVersion.length > 0 ? withoutNodeVersion : cleaned;
  let errorIndex = -1;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (/(syntaxerror|typeerror|referenceerror|error:|exception)/i.test(source[index])) {
      errorIndex = index;
      break;
    }
  }
  const focus = errorIndex >= 0
    ? source.slice(Math.max(0, errorIndex - 1), Math.min(source.length, errorIndex + 2))
    : source.slice(-2);
  return focus.join(" | ").slice(0, 500);
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

function looksLikeClarifyingPrompt(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.includes("question limit reached")) {
    return false;
  }
  if (trimmed.includes("?")) {
    return true;
  }
  return /^(укажите|подтвердите|нужно|нужен|нужна|какой|какая|какие|provide|specify|confirm|what|which|do you|should|need)\b/i
    .test(trimmed);
}

function collectAskedQuestionKeys(messages: TriggerChatMessage[]): Set<string> {
  const asked = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const content = message.content.trim();
    if (!content) {
      continue;
    }
    const extracted = extractQuestionCandidatesFromRaw(content);
    if (extracted.length > 0) {
      for (const question of extracted) {
        const key = normalizeQuestionKey(question);
        if (key) {
          asked.add(key);
        }
      }
      continue;
    }
    if (!looksLikeClarifyingPrompt(content)) {
      continue;
    }
    const key = normalizeQuestionKey(content);
    if (key) {
      asked.add(key);
    }
  }
  return asked;
}

function buildNeedsInputQuestions(
  messages: TriggerChatMessage[],
  candidateQuestions: string[],
  fallback: string,
): string[] {
  const askedSet = collectAskedQuestionKeys(messages);
  const remaining = Math.max(0, MAX_TRIGGER_QUESTIONS - askedSet.size);

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
    "For script_poll triggered=true responses: include payload object with business/event data, not just reason.",
    "If source provides message/task data (Telegram, webhook body, GitHub event), pass it inside payload fields.",
    "For Telegram triggers include at least payload.chatId and payload.text when available.",
    "For agent_poll: define concise check instructions in agentPrompt and still return trigger JSON format.",
    "JSON must always include triggered boolean; include reason and payload whenever possible.",
    "{\"triggered\":true,\"reason\":\"...\",\"payload\":{\"chatId\":\"...\",\"text\":\"...\"}}",
    "or",
    "{\"triggered\":false,\"reason\":\"...\"}",
    `Event payload delivery is built-in: downstream workflow agents receive ${TRIGGER_INPUT_CHANNEL} and ${TRIGGER_EVENT_DATA_CHANNEL} automatically.`,
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
    "Always include a non-empty reason string.",
    "When triggered=false, include diagnostics with blocker and observed counters.",
    "{\"triggered\":true,\"reason\":\"...\",\"diagnostics\":{\"visibleItems\":3,\"pageUrl\":\"...\"}}",
    "or",
    "{\"triggered\":false,\"reason\":\"...\",\"diagnostics\":{\"blocker\":\"...\",\"visibleItems\":0,\"pageUrl\":\"...\"}}",
    "You may include extra JSON fields for downstream workflow payload.",
  ].join("\n");
}

function extractReasonFromPollPayload(payload: Record<string, unknown>): string | undefined {
  const reason = extractReasonFromUnknownPayload(payload);
  return reason || undefined;
}

function inferNotTriggeredReasonFromText(raw: string): string | null {
  const normalized = raw.trim();
  if (!normalized) {
    return null;
  }
  const lowered = normalized.toLowerCase();
  if (lowered.includes("gateway closed")) {
    return "Browser control unavailable (gateway closed).";
  }
  if (lowered.includes("browser control unavailable")) {
    return "Browser control unavailable.";
  }
  if (lowered.includes("browser unavailable")) {
    return "Browser unavailable.";
  }
  if (lowered.includes("cannot load page") || lowered.includes("unable to load page")) {
    return "Cannot load page.";
  }
  if (lowered.includes("condition not met")) {
    return "condition not met";
  }
  return null;
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

function stringifyTriggerValue(value: unknown): string {
  try {
    const normalized = value === undefined ? null : value;
    const compact = JSON.stringify(normalized);
    if (!compact) {
      return "{}";
    }
    if (compact.length <= TRIGGER_INPUT_PREVIEW_MAX_CHARS) {
      return JSON.stringify(normalized, null, 2);
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

const TRIGGER_EVENT_DATA_KEYS = [
  "eventData",
  "event_data",
  "event",
  "data",
  "payload",
  "input",
  "body",
  "result",
  "details",
  "message",
  "content",
  "text",
];

const TRIGGER_CONTROL_KEYS = new Set([
  "triggered",
  "reason",
  "source",
  "diagnostics",
  "rawreport",
  "status",
  "error",
  "message",
]);

type TriggerInputEnvelope = {
  full: Record<string, unknown>;
  eventData: unknown;
  reason: string;
};

function normalizeEventDataFromTriggerPayload(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) {
    return value;
  }
  if (!isObjectRecord(value)) {
    return value;
  }

  for (const key of TRIGGER_EVENT_DATA_KEYS) {
    if (!(key in value)) {
      continue;
    }
    const candidate = value[key];
    if (candidate === undefined || candidate === null) {
      continue;
    }
    if (typeof candidate === "string" && !candidate.trim()) {
      continue;
    }
    return normalizeEventDataFromTriggerPayload(candidate, depth + 1);
  }

  const businessEntries = Object.entries(value).filter(([key]) => !TRIGGER_CONTROL_KEYS.has(key.trim().toLowerCase()));
  if (businessEntries.length > 0) {
    return Object.fromEntries(businessEntries);
  }
  return value;
}

function extractReasonFromUnknownPayload(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) {
    return "";
  }
  if (!isObjectRecord(value)) {
    return "";
  }

  const reason = asString(value.reason).trim();
  if (reason) {
    return reason;
  }

  const error = asString(value.error).trim();
  if (error) {
    return `error=${error}`;
  }

  const message = asString(value.message).trim();
  if (message) {
    return message;
  }

  const blocker = asString(value.blocker).trim();
  if (blocker) {
    return `blocker=${blocker}`;
  }

  for (const key of TRIGGER_EVENT_DATA_KEYS) {
    if (!(key in value)) {
      continue;
    }
    const nested = extractReasonFromUnknownPayload(value[key], depth + 1);
    if (nested) {
      return nested;
    }
  }
  return "";
}

function buildTriggerInputEnvelope(meta: Record<string, unknown>): TriggerInputEnvelope {
  const source = asString(meta.source).trim() || "unknown";
  const payload = Object.prototype.hasOwnProperty.call(meta, "payload") ? meta.payload : meta;
  const eventData = normalizeEventDataFromTriggerPayload(payload);
  const explicitReason = asString(meta.reason).trim();
  const reason = explicitReason || extractReasonFromUnknownPayload(payload) || `source=${source}`;
  return {
    reason,
    eventData,
    full: {
      ...meta,
      source,
      reason,
      receivedAt: new Date().toISOString(),
      payload,
      eventData,
    },
  };
}

function buildTriggerInputBlock(envelope: TriggerInputEnvelope): string {
  return [
    "Trigger runtime input:",
    `Channels: ${TRIGGER_INPUT_CHANNEL}, ${TRIGGER_EVENT_DATA_CHANNEL}`,
    "This payload came from the event that started the current workflow run and may represent arbitrary event data.",
    `${TRIGGER_INPUT_CHANNEL}:`,
    stringifyTriggerValue(envelope.full),
    `${TRIGGER_EVENT_DATA_CHANNEL}:`,
    stringifyTriggerValue(envelope.eventData),
    "Use KOVALSKY_TRIGGER_EVENT_DATA_JSON for business/event payload and KOVALSKY_TRIGGER_INPUT_JSON as full envelope.",
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

function normalizeReasonToken(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
}

function isBenignNotTriggeredReason(reason: string): boolean {
  const normalized = normalizeReasonToken(reason);
  return QUIET_NOT_TRIGGERED_REASONS.has(normalized);
}

function shouldHideTriggerHistoryLine(content: string): boolean {
  const trimmed = content.trim();
  const match = trimmed.match(/^check:\s*not triggered\s*\(([^)]+)\)/i);
  if (!match?.[1]) {
    return false;
  }
  return isBenignNotTriggeredReason(match[1]);
}

function filterTriggerHistoryForDisplay(history: TriggerHistoryEntry[] | undefined): TriggerHistoryEntry[] {
  const source = history ?? [];
  return source.filter((entry) => !shouldHideTriggerHistoryLine(entry.content));
}

function looksLikeSuccessfulBrowserInspection(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const hardNegativeSignals = [
    "no data",
    "unable to open",
    "could not open",
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

function looksLikeBrowserInspectionCompletedDespiteTransientIssue(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const hasTransientSignal = isTransientAgentPollReason(normalized)
    || normalized.includes("browser control service unavailable")
    || normalized.includes("unable to inspect");
  if (!hasTransientSignal) {
    return false;
  }

  const positiveSignals = [
    "tiktok",
    "opened",
    "open",
    "navigate",
    "video",
    "visible",
    "caption",
    "likes",
    "comments",
    "shares",
    "close tab",
    "closed tab",
  ];
  const score = positiveSignals.reduce((sum, token) => sum + (normalized.includes(token) ? 1 : 0), 0);
  return score >= 4;
}

function hasMeaningfulAgentPollPayload(payload: unknown): boolean {
  if (!isObjectRecord(payload)) {
    return false;
  }

  const positiveKeyPattern = /(video|videos|item|items|post|posts|entry|entries|result|results|data|title|titles|channel|channels|view|views|comment|comments|caption|captions|url|urls|text|author|authors)/i;
  const technicalOrErrorKeyPattern = /(error|errors|exception|warning|code|status|diagnostic|debug|raw|rawreport|message)/i;
  const negativeValuePattern = /(error|unavailable|timeout|timed out|failed|unable|cannot|exception|gateway closed|eaddrinuse)/i;

  for (const [key, value] of Object.entries(payload)) {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey === "triggered" || normalizedKey === "reason") {
      continue;
    }
    if (technicalOrErrorKeyPattern.test(normalizedKey)) {
      continue;
    }

    const keyLooksLikeBusinessData = positiveKeyPattern.test(normalizedKey);

    if (typeof value === "string" && value.trim()) {
      const normalizedValue = value.trim().toLowerCase();
      if (negativeValuePattern.test(normalizedValue)) {
        continue;
      }
      if (keyLooksLikeBusinessData || normalizedValue.length >= 24) {
        return true;
      }
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && keyLooksLikeBusinessData) {
      return true;
    }
    if (Array.isArray(value) && value.length > 0 && keyLooksLikeBusinessData) {
      return true;
    }
    if (isObjectRecord(value) && Object.keys(value).length > 0 && keyLooksLikeBusinessData) {
      return true;
    }
  }

  return false;
}

export class TriggerService {
  private readonly watchers = new Map<string, ActiveWatcher>();
  private readonly webhookIndex = new Map<string, string>();
  private readonly runtimeDir: string;
  private agentPollLock: Promise<void> = Promise.resolve();

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

    const intervalSeconds = Math.max(3, Math.floor(asNumber(configRaw.intervalSeconds) ?? 60));
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

    let config = triggerState.generated;
    if (!config) {
      throw new Error("Generate the trigger before activating it.");
    }

    // Ensure every script_poll trigger writes to an isolated per-node path.
    // This prevents multiple trigger nodes from overwriting the same check-trigger.mjs file.
    if (config.type === "script_poll") {
      const isolatedScriptPath = this.writeScriptFile(
        workspacePath,
        input.nodeId,
        config.scriptFileName,
        config.scriptContent,
      );
      config = {
        ...config,
        scriptPath: isolatedScriptPath,
      };
      this.persistTriggerState(input.pipelineId, input.nodeId, {
        workspacePath,
        generated: config,
      });
    }

    const existingWatcher = this.watchers.get(watcherKey);
    if (existingWatcher) {
      const sameConfig = JSON.stringify(existingWatcher.config) === JSON.stringify(config)
        && existingWatcher.workspacePath === workspacePath
        && existingWatcher.pipelineId === input.pipelineId
        && existingWatcher.nodeId === input.nodeId;
      if (sameConfig) {
        return this.buildStatusResponse(existingWatcher, triggerState.summary);
      }
      this.stopWatcher(watcherKey);
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
    const existing = this.stopWatcher(key);
    if (existing) {
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
    if (!node || node.agentId !== "trigger") {
      return { status: "draft" };
    }
    const triggerState = this.readTriggerState(node?.settings);
    const status = triggerState.generated ? "paused" : "draft";
    if (status === "paused") {
      this.appendTriggerHistory(input.pipelineId, input.nodeId, "Trigger paused.");
    }
    this.persistTriggerState(input.pipelineId, input.nodeId, {
      lifecycleStatus: status,
    });
    return {
      status,
      summary: triggerState.summary,
      webhookPath: triggerState.generated?.type === "webhook" ? `/trigger-hooks/${triggerState.generated.token}` : null,
      scriptPath: triggerState.generated?.type === "script_poll" ? triggerState.generated.scriptPath ?? null : null,
      lastError: triggerState.lastError ?? null,
      history: filterTriggerHistoryForDisplay(triggerState.history),
    };
  }

  getTriggerStatus(input: {
    pipelineId: string;
    nodeId: string;
  }): TriggerStatusResponse {
    const watcher = this.watchers.get(this.toWatcherKey(input.pipelineId, input.nodeId));
    if (watcher) {
      const pipeline = this.db.getPipeline(input.pipelineId);
      if (pipeline) {
        const graph = JSON.parse(pipeline.graph_json) as PipelineGraph;
        const node = graph.nodes.find((item) => item.id === input.nodeId);
        const triggerState = this.readTriggerState(node?.settings);
        if (triggerState.lifecycleStatus !== "active") {
          this.persistTriggerState(input.pipelineId, input.nodeId, {
            lifecycleStatus: "active",
          });
        }
      }
      return this.buildStatusResponse(watcher);
    }

    const pipeline = this.db.getPipeline(input.pipelineId);
    if (!pipeline) {
      return { status: "draft" };
    }
    const graph = JSON.parse(pipeline.graph_json) as PipelineGraph;
    const node = graph.nodes.find((item) => item.id === input.nodeId);
    if (!node || node.agentId !== "trigger") {
      return { status: "draft" };
    }
    const triggerState = this.readTriggerState(node?.settings);
    const status = triggerState.generated ? (triggerState.lifecycleStatus === "draft" ? "paused" : triggerState.lifecycleStatus) : "draft";
    if (status === "active" && !watcher) {
      // Self-heal stale persisted state when runtime watcher is not alive.
      this.persistTriggerState(input.pipelineId, input.nodeId, {
        lifecycleStatus: "paused",
      });
    }
    return {
      status: status === "active" ? "paused" : status,
      summary: triggerState.summary,
      webhookPath: triggerState.generated?.type === "webhook" ? `/trigger-hooks/${triggerState.generated.token}` : null,
      scriptPath: triggerState.generated?.type === "script_poll" ? triggerState.generated.scriptPath ?? null : null,
      lastError: triggerState.lastError ?? null,
      history: filterTriggerHistoryForDisplay(triggerState.history),
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
      reason: "Webhook request received.",
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
      let agentPollRaw = "";

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
        diagnostics = summarizeScriptPollDiagnostics(stderrLines);
      } else if (watcher.config.type === "agent_poll") {
        let lastRaw = "";
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            const raw = await this.withAgentPollLock(() => this.runAgentPollCheck(watcher));
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
        agentPollRaw = lastRaw.trim();
        const reason = asString(checkResult.reason).trim().toLowerCase();
        if (
          checkResult.parsed
          && !checkResult.triggered
          && (
            (reason === "condition not met" && looksLikeSuccessfulBrowserInspection(lastRaw))
            || (isTransientAgentPollReason(reason) && looksLikeBrowserInspectionCompletedDespiteTransientIssue(lastRaw))
            || hasMeaningfulAgentPollPayload(checkResult.payload)
          )
        ) {
          checkResult = {
            parsed: true,
            triggered: true,
            reason: isTransientAgentPollReason(reason)
              ? "Heuristic override: browser inspection completed despite transient browser error."
              : "Heuristic override: browser inspection reported visible page data.",
            payload: {
              triggered: true,
              reason: isTransientAgentPollReason(reason)
                ? "Heuristic override: browser inspection completed despite transient browser error."
                : "Heuristic override: browser inspection reported visible page data.",
              heuristic: true,
              rawReport: lastRaw.trim().slice(-4_000),
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

      if (watcher.config.type === "agent_poll" && checkResult.parsed && checkResult.triggered && agentPollRaw) {
        const payload = isObjectRecord(checkResult.payload) ? { ...checkResult.payload } : {};
        if (typeof payload.rawReport !== "string" || !payload.rawReport.trim()) {
          payload.rawReport = agentPollRaw.slice(-4_000);
        }
        checkResult.payload = payload;
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
        const previousLastError = watcher.lastError;
        const notTriggeredReason = (checkResult.reason ?? "").trim()
          || "agent returned triggered=false without reason/diagnostics (агент не объяснил причину)";
        watcher.lastError = diagnostics ?? (isTransientAgentPollReason(notTriggeredReason) ? notTriggeredReason : null);
        const notTriggeredDetails = this.buildNotTriggeredDetails(checkResult.payload, agentPollRaw);
        const suffixParts: string[] = [];
        if (notTriggeredDetails) {
          suffixParts.push(`Details: ${notTriggeredDetails}`);
        }
        if (
          watcher.lastError
          && (!notTriggeredDetails || !notTriggeredDetails.toLowerCase().includes(watcher.lastError.toLowerCase()))
        ) {
          suffixParts.push(`Error: ${watcher.lastError}`);
        }
        const shouldKeepQuiet = isBenignNotTriggeredReason(notTriggeredReason)
          && suffixParts.length === 0
          && !watcher.lastError;
        if (!shouldKeepQuiet) {
          this.pushWatcherHistory(
            watcher,
            suffixParts.length > 0
              ? `Check: not triggered (${notTriggeredReason}). ${suffixParts.join(" ")}`
              : `Check: not triggered (${notTriggeredReason}).`,
          );
        } else if (previousLastError === watcher.lastError) {
          return;
        }
        this.persistTriggerState(watcher.pipelineId, watcher.nodeId, {
          lastError: watcher.lastError,
          history: watcher.history,
        });
        return;
      }

      const fire = await this.fireWatcherWorkflow(watcher, {
        source: watcher.config.type,
        reason: checkResult.reason ?? `Trigger matched (${watcher.config.type}).`,
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
        // Fixed-delay scheduling: wait full interval after each finished check cycle.
        // This prevents back-to-back restarts when a check duration is close to/over the interval.
        const nextDelayMs = stillActive.config.type === "agent_poll"
          ? Math.max(AGENT_POLL_MIN_DELAY_MS, intervalMs)
          : intervalMs;
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
          const reason = extractReasonFromPollPayload(parsed);
          return {
            parsed: true,
            triggered: false,
            reason,
            payload: parsed,
          };
        }
        if (isObjectRecord(parsed)) {
          const nested = this.extractDecisionFromUnknown(parsed);
          if (nested) {
            return nested;
          }
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
      const nested = this.extractDecisionFromUnknown(parsed ?? raw);
      if (nested) {
        return nested;
      }
      const fromRaw = this.extractDecisionFromRawText(raw);
      if (fromRaw) {
        return fromRaw;
      }
      const inferredReason = inferNotTriggeredReasonFromText(raw);
      if (inferredReason) {
        return {
          parsed: true,
          triggered: false,
          reason: inferredReason,
          payload: {
            triggered: false,
            reason: inferredReason,
          },
        };
      }
      return { parsed: false, triggered: false };
    }

    return {
      parsed: true,
      triggered: parsed.triggered,
      reason: extractReasonFromPollPayload(parsed),
      payload: parsed,
    };
  }

  private extractDecisionFromRawText(raw: string): PollCheckResult | null {
    const normalized = raw.trim();
    if (!normalized) {
      return null;
    }
    const cleaned = normalized.length > MAX_TRIGGER_PARSE_CHARS
      ? normalized.slice(-MAX_TRIGGER_PARSE_CHARS)
      : normalized;
    const decisionMarkers = [...cleaned.matchAll(/"triggered"\s*:\s*(?:true|false)/gi)];
    for (let markerIdx = decisionMarkers.length - 1; markerIdx >= 0; markerIdx -= 1) {
      const markerIndex = decisionMarkers[markerIdx].index ?? -1;
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
            const nested = this.extractDecisionFromUnknown(parsed, 1);
            if (nested) {
              return nested;
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

  private extractDecisionFromUnknown(value: unknown, depth = 0, rootPayload: unknown = value): PollCheckResult | null {
    if (depth > 6 || value === null || value === undefined) {
      return null;
    }

    if (isObjectRecord(value)) {
      if (typeof value.triggered === "boolean") {
        const payload = isObjectRecord(rootPayload)
          ? rootPayload
          : value;
        return {
          parsed: true,
          triggered: value.triggered,
          reason: extractReasonFromPollPayload(payload),
          payload,
        };
      }

      const priorityKeys = ["payload", "result", "data", "message", "content", "text", "output"];
      for (const key of priorityKeys) {
        if (key in value) {
          const nested = this.extractDecisionFromUnknown(value[key], depth + 1, rootPayload);
          if (nested) {
            return nested;
          }
        }
      }
      for (const nestedValue of Object.values(value)) {
        const nested = this.extractDecisionFromUnknown(nestedValue, depth + 1, rootPayload);
        if (nested) {
          return nested;
        }
      }
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = this.extractDecisionFromUnknown(item, depth + 1, rootPayload);
        if (nested) {
          return nested;
        }
      }
      return null;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const parsed = extractJsonObject(trimmed);
      if (parsed) {
        return this.extractDecisionFromUnknown(parsed, depth + 1, rootPayload);
      }
      return null;
    }

    return null;
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

    const timeoutSeconds = Math.max(120, Math.floor(watcher.config.timeoutSeconds));
    const baseSettings = isObjectRecord(watcher.agentSettings) ? { ...watcher.agentSettings } : {};
    const profile = asString(baseSettings.profile).trim() || "full";
    const settings = {
      ...baseSettings,
      useProfile: true,
      profile,
      // Trigger checks should run in isolated OpenClaw state to avoid
      // browser-control loopback port contention (EADDRINUSE) between runs.
      useIsolatedState: true,
      reportRuntimeLikeAgent: true,
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
    const triggerInputEnvelope = buildTriggerInputEnvelope(meta);
    const triggerInputBlock = buildTriggerInputBlock(triggerInputEnvelope);
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
    const triggerReason = triggerInputEnvelope.reason;
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
      content: `Trigger fired automatically.\nMeta: ${JSON.stringify(triggerInputEnvelope.full)}`,
      meta: {
        source: "trigger_service",
        ...triggerInputEnvelope.full,
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
    const nodeDir = sanitizeFileName(nodeId, "trigger-node");
    const targetDir = path.join(workspacePath, ".kovalsky", "triggers", nodeDir);
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
        intervalSeconds: Math.max(3, Math.floor(asNumber(value.intervalSeconds) ?? 60)),
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
      history: filterTriggerHistoryForDisplay(source.history),
    };
  }

  private toWatcherKey(pipelineId: string, nodeId: string): string {
    return `${pipelineId}:${nodeId}`;
  }

  private stopWatcher(key: string): ActiveWatcher | null {
    const existing = this.watchers.get(key);
    if (!existing) {
      return null;
    }

    if (existing.timer) {
      clearTimeout(existing.timer);
      existing.timer = null;
    }
    if (existing.config.type === "webhook") {
      this.webhookIndex.delete(existing.config.token);
    }
    this.watchers.delete(key);
    return existing;
  }

  private async withAgentPollLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.agentPollLock;
    let release = () => {};
    this.agentPollLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
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

  private buildNotTriggeredDetails(payload: unknown, raw: string): string | null {
    const parts: string[] = [];
    const payloadObject = isObjectRecord(payload) ? payload : null;
    const rawReport = payloadObject && typeof payloadObject.rawReport === "string" ? payloadObject.rawReport.trim() : "";

    if (payloadObject) {
      const error = asString(payloadObject.error).trim();
      if (error) {
        parts.push(`error=${error}`);
      }
      const message = asString(payloadObject.message).trim();
      if (message) {
        parts.push(`message=${message.slice(0, 180)}`);
      }
      const extra = Object.entries(payloadObject)
        .filter(([key]) => !["triggered", "reason", "rawReport", "error", "message"].includes(key))
        .slice(0, 3)
        .map(([key, value]) => {
          if (typeof value === "string") {
            return `${key}=${value.slice(0, 120)}`;
          }
          if (typeof value === "number" || typeof value === "boolean") {
            return `${key}=${String(value)}`;
          }
          if (Array.isArray(value)) {
            return `${key}=[${value.length}]`;
          }
          if (isObjectRecord(value)) {
            return `${key}={...}`;
          }
          return "";
        })
        .filter(Boolean);
      parts.push(...extra);
    }

    const rawCandidate = rawReport || raw.trim();
    if (rawCandidate) {
      const hint = this.extractRawNotTriggeredHint(rawCandidate);
      if (hint) {
        parts.push(`raw=${hint}`);
      }
    }

    if (parts.length === 0) {
      return null;
    }
    return parts.join("; ").slice(0, 500);
  }

  private extractRawNotTriggeredHint(raw: string): string | null {
    const ignored = /^(gateway target:|source:|config:|bind:)/i;
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !ignored.test(line));

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isObjectRecord(parsed)) {
          if (parsed.triggered === false) {
            const minimalReason = extractReasonFromPollPayload(parsed);
            if (!minimalReason) {
              return "triggered=false (agent did not provide reason/diagnostics; агент не указал причину)";
            }
          }
          const reason = asString(parsed.reason).trim();
          const error = asString(parsed.error).trim();
          const message = asString(parsed.message).trim();
          const payloadParts = [
            reason ? `reason=${reason}` : "",
            error ? `error=${error}` : "",
            message ? `message=${message}` : "",
          ].filter(Boolean);
          if (payloadParts.length > 0) {
            return payloadParts.join(", ").slice(0, 220);
          }
        }
      } catch {
        // Keep scanning plain text hints.
      }

      if (line.length > 0) {
        return line.slice(0, 220);
      }
    }

    return null;
  }
}
