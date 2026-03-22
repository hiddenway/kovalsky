import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { AgentHost } from "./agent-host";
import { DatabaseService } from "../db";
import { ProcessManager } from "./process-manager";
import { RunService } from "./run-service";
import type { PipelineGraph } from "../types";
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
  workspacePath: string;
  config: TriggerGeneratedConfig;
  status: "active";
  timer: NodeJS.Timeout | null;
  runningCheck: boolean;
  lastCheckAt: string | null;
  lastFireAt: string | null;
  lastRunId: string | null;
  lastError: string | null;
  webhookPath: string | null;
  history: TriggerHistoryEntry[];
};

type TriggerStatusResponse = {
  status: "draft" | "paused" | "active";
  summary?: string;
  webhookPath?: string | null;
  scriptPath?: string | null;
  lastCheckAt?: string | null;
  lastFireAt?: string | null;
  lastRunId?: string | null;
  lastError?: string | null;
  history?: TriggerHistoryEntry[];
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
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

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
    return null;
  }
}

function includesAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function collectTriggerTextCorpus(goal: string, messages: TriggerChatMessage[]): string {
  return [goal, ...messages.map((message) => message.content)]
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n");
}

function extractTelegramBotTokenFromText(text: string): string | null {
  const matches = text.match(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g);
  if (!matches || matches.length === 0) {
    return null;
  }
  return matches[matches.length - 1] ?? null;
}

function shouldUseTelegramAnyTextPolling(goal: string, messages: TriggerChatMessage[]): {
  token: string;
} | null {
  const corpus = collectTriggerTextCorpus(goal, messages);
  const token = extractTelegramBotTokenFromText(corpus);
  if (!token) {
    return null;
  }

  const normalized = corpus.toLowerCase();
  const hasTelegramHint = includesAny(normalized, [
    "telegram",
    "телеграм",
    "бот",
    "bot",
  ]);
  const hasPollingHint = includesAny(normalized, [
    "polling",
    "poll",
    "long poll",
    "лонгполл",
    "через токен",
    "по токену",
    "token",
  ]);
  const hasAnyTextHint = includesAny(normalized, [
    "any text",
    "any message",
    "every message",
    "all messages",
    "любой текст",
    "любое сообщение",
    "каждое сообщение",
    "каждое новое сообщение",
    "все сообщения",
    "всё что угодно",
    "что отправит пользователь",
  ]);

  if (!hasTelegramHint) {
    return null;
  }
  if (!hasPollingHint && !hasAnyTextHint) {
    return null;
  }

  return { token };
}

function buildTelegramAnyTextPollingScript(token: string, nodeId: string): {
  fileName: string;
  content: string;
} {
  const safeNodeId = nodeId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "trigger";
  const fileName = `telegram-any-text-${safeNodeId}.mjs`;
  const stateFileName = `telegram-offset-${safeNodeId}.json`;
  const encodedToken = JSON.stringify(token);
  const encodedStateFileName = JSON.stringify(stateFileName);

  const content = [
    "import fs from \"node:fs\";",
    "import path from \"node:path\";",
    "",
    `const BOT_TOKEN = ${encodedToken};`,
    `const STATE_FILE_NAME = ${encodedStateFileName};`,
    "const workspacePath = process.env.KOVALSKY_TRIGGER_WORKSPACE_PATH || process.cwd();",
    "const stateDir = path.join(workspacePath, \".kovalsky\", \"triggers\");",
    "const statePath = path.join(stateDir, STATE_FILE_NAME);",
    "",
    "function readOffset() {",
    "  try {",
    "    const parsed = JSON.parse(fs.readFileSync(statePath, \"utf8\"));",
    "    return Number.isInteger(parsed?.offset) && parsed.offset > 0 ? parsed.offset : null;",
    "  } catch {",
    "    return null;",
    "  }",
    "}",
    "",
    "function writeOffset(offset) {",
    "  fs.mkdirSync(stateDir, { recursive: true });",
    "  fs.writeFileSync(statePath, `${JSON.stringify({ offset })}\\n`, \"utf8\");",
    "}",
    "",
    "function summarize(update) {",
    "  const text = typeof update?.message?.text === \"string\" ? update.message.text.trim() : \"\";",
    "  const compact = text.replace(/\\s+/g, \" \").slice(0, 220);",
    "  if (!compact) {",
    "    return null;",
    "  }",
    "  const from = update?.message?.from;",
    "  const user = from?.username ? `@${from.username}` : (from?.id ? String(from.id) : \"unknown\");",
    "  return `Telegram text from ${user}: ${compact}`;",
    "}",
    "",
    "const previousOffset = readOffset();",
    "const url = new URL(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);",
    "url.searchParams.set(\"timeout\", \"0\");",
    "url.searchParams.set(\"allowed_updates\", JSON.stringify([\"message\"]));",
    "if (previousOffset && previousOffset > 0) {",
    "  url.searchParams.set(\"offset\", String(previousOffset));",
    "}",
    "",
    "const response = await fetch(url, {",
    "  method: \"GET\",",
    "  headers: { accept: \"application/json\" },",
    "});",
    "if (!response.ok) {",
    "  console.log(JSON.stringify({ triggered: false, reason: `Telegram API HTTP ${response.status}` }));",
    "  process.exit(0);",
    "}",
    "",
    "const payload = await response.json();",
    "if (!payload || payload.ok !== true || !Array.isArray(payload.result)) {",
    "  console.log(JSON.stringify({ triggered: false, reason: \"Telegram API payload is invalid.\" }));",
    "  process.exit(0);",
    "}",
    "",
    "const updates = payload.result.filter((entry) => Number.isInteger(entry?.update_id));",
    "if (updates.length === 0) {",
    "  console.log(JSON.stringify({ triggered: false }));",
    "  process.exit(0);",
    "}",
    "",
    "const maxUpdateId = updates.reduce((max, item) => (item.update_id > max ? item.update_id : max), 0);",
    "const nextOffset = maxUpdateId + 1;",
    "const hadOffset = Boolean(previousOffset && previousOffset > 0);",
    "writeOffset(nextOffset);",
    "",
    "if (!hadOffset) {",
    "  console.log(JSON.stringify({ triggered: false }));",
    "  process.exit(0);",
    "}",
    "",
    "for (let index = updates.length - 1; index >= 0; index -= 1) {",
    "  const reason = summarize(updates[index]);",
    "  if (!reason) {",
    "    continue;",
    "  }",
    "  console.log(JSON.stringify({ triggered: true, reason }));",
    "  process.exit(0);",
    "}",
    "",
    "console.log(JSON.stringify({ triggered: false }));",
  ].join("\n");

  return { fileName, content };
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
    "Otherwise choose script_poll and generate a Node.js 18+ script.",
    "If user already provided broad event text (e.g. any message / any text), treat it as sufficient and do not ask repeated clarifications.",
    "For script_poll: no dependencies, use global fetch only, print exactly one JSON line.",
    "The JSON line must be either {\"triggered\":true,\"reason\":\"...\"} or {\"triggered\":false}.",
    "If information is insufficient, ask up to 3 short clarifying questions.",
    "Output strict JSON only with one of these shapes:",
    "{\"status\":\"needs_input\",\"questions\":[\"...\"]}",
    "{\"status\":\"ready\",\"summary\":\"...\",\"config\":{\"type\":\"webhook\",\"token\":\"...\",\"secret\":\"...\",\"method\":\"POST\",\"coolDownSeconds\":60}}",
    "{\"status\":\"ready\",\"summary\":\"...\",\"config\":{\"type\":\"script_poll\",\"intervalSeconds\":60,\"timeoutSeconds\":30,\"coolDownSeconds\":60,\"scriptFileName\":\"check-trigger.mjs\",\"scriptContent\":\"...\"}}",
  ].join("\n");
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
      timeoutMs: 120_000,
    });

    const parsed = extractJsonObject(raw);
    if (!parsed) {
      const heuristicReady = this.tryBuildHeuristicTriggerResponse(input, workspacePath, raw);
      if (heuristicReady) {
        return heuristicReady;
      }
      return {
        status: "needs_input",
        questions: [
          "I could not derive a valid trigger yet. What exact event should start the workflow?",
        ],
        raw,
      };
    }

    const status = asString(parsed.status).trim().toLowerCase();
    if (status === "needs_input") {
      const heuristicReady = this.tryBuildHeuristicTriggerResponse(input, workspacePath, raw);
      if (heuristicReady) {
        return heuristicReady;
      }
      const questions = ensureArrayOfStrings(parsed.questions).slice(0, 3);
      return {
        status: "needs_input",
        questions: questions.length > 0
          ? questions
          : ["What exact event should I monitor for this trigger?"],
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

    const intervalSeconds = Math.max(15, Math.floor(asNumber(configRaw.intervalSeconds) ?? 60));
    const timeoutSeconds = Math.max(5, Math.floor(asNumber(configRaw.timeoutSeconds) ?? 30));
    const coolDownSeconds = Math.max(5, Math.floor(asNumber(configRaw.coolDownSeconds) ?? 60));
    const scriptFileName = sanitizeFileName(asString(configRaw.scriptFileName), `${input.nodeId}-trigger`);
    const scriptContent = asString(configRaw.scriptContent).trim();
    if (!scriptContent) {
      const heuristicReady = this.tryBuildHeuristicTriggerResponse(input, workspacePath, raw);
      if (heuristicReady) {
        return heuristicReady;
      }
      return {
        status: "needs_input",
        questions: ["I need more detail for polling. What exact endpoint, page, or condition should the script check?"],
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

  private tryBuildHeuristicTriggerResponse(
    input: TriggerGenerationRequest,
    workspacePath: string,
    raw: string,
  ): TriggerGenerationResponse | null {
    const messages = input.messages ?? [];
    const telegramPolling = shouldUseTelegramAnyTextPolling(input.goal, messages);
    if (telegramPolling) {
      const script = buildTelegramAnyTextPollingScript(telegramPolling.token, input.nodeId);
      const scriptPath = this.writeScriptFile(workspacePath, input.nodeId, script.fileName, script.content);
      return {
        status: "ready",
        summary: "Telegram polling trigger generated: workflow starts on each new text message sent to the bot.",
        config: {
          type: "script_poll",
          intervalSeconds: 20,
          timeoutSeconds: 15,
          coolDownSeconds: 5,
          scriptFileName: script.fileName,
          scriptContent: script.content,
          scriptPath,
        },
        scriptPath,
        raw: raw.trim() ? `${raw.trim()}\n[heuristic_fallback=telegram_any_text_polling]` : "[heuristic_fallback=telegram_any_text_polling]",
      };
    }

    return null;
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
      workspacePath,
      config,
      status: "active",
      timer: null,
      runningCheck: false,
      lastCheckAt: null,
      lastFireAt: null,
      lastRunId: null,
      lastError: null,
      webhookPath: config.type === "webhook" ? `/trigger-hooks/${config.token}` : null,
      history: triggerState.history ?? [],
    };

    if (config.type === "script_poll") {
      watcher.timer = setInterval(() => {
        void this.pollWatcher(watcher.key);
      }, config.intervalSeconds * 1000);
      void this.pollWatcher(watcher.key);
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
    if (!watcher || watcher.config.type !== "script_poll" || watcher.runningCheck) {
      return;
    }

    watcher.runningCheck = true;
    watcher.lastCheckAt = new Date().toISOString();

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    try {
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

      const payload = this.parsePollOutput(stdoutLines);
      if (!payload.triggered) {
        watcher.lastError = stderrLines.filter(Boolean).slice(-1)[0] ?? null;
        if (watcher.lastError) {
          this.persistTriggerState(watcher.pipelineId, watcher.nodeId, {
            lastError: watcher.lastError,
          });
        }
        return;
      }

      const fire = await this.fireWatcherWorkflow(watcher, {
        source: "script_poll",
        payload,
      });
      watcher.lastError = fire.reason ?? null;
    } catch (error) {
      watcher.lastError = error instanceof Error ? error.message : "Trigger poll failed.";
      this.logger.warn({ err: error, key }, "trigger poll failed");
      this.persistTriggerState(watcher.pipelineId, watcher.nodeId, {
        lastError: watcher.lastError,
      });
    } finally {
      watcher.runningCheck = false;
    }
  }

  private parsePollOutput(lines: string[]): { triggered: boolean; reason?: string } {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) {
        continue;
      }
      if (line === "TRIGGER_FIRED") {
        return { triggered: true, reason: "Trigger script emitted TRIGGER_FIRED." };
      }
      try {
        const parsed = JSON.parse(line) as { triggered?: unknown; reason?: unknown };
        if (parsed.triggered === true) {
          return {
            triggered: true,
            reason: typeof parsed.reason === "string" ? parsed.reason : "Trigger script reported a match.",
          };
        }
        if (parsed.triggered === false) {
          return { triggered: false };
        }
      } catch {
        continue;
      }
    }

    return { triggered: false };
  }

  private async fireWatcherWorkflow(
    watcher: ActiveWatcher,
    meta: Record<string, unknown>,
  ): Promise<{ runId: string | null; reason: string | null }> {
    const now = Date.now();
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
    const nextStages = graph.edges
      .filter((edge) => edge.source === watcher.nodeId)
      .map((edge) => graph.nodes.find((node) => node.id === edge.target))
      .filter((node): node is NonNullable<typeof node> => Boolean(node))
      .map((node) => `${node.agentId}:${node.id}`);
    const started = await this.runService.startRun(watcher.pipelineId, graph, {
      workspacePath: watcher.workspacePath,
      clearNodeChatContext: false,
    });

    watcher.lastFireAt = new Date().toISOString();
    watcher.lastRunId = started.runId;
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
      status: watcher ? "active" : "paused",
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
