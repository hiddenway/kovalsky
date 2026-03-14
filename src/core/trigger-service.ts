import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { AgentHost } from "./agent-host";
import { DatabaseService } from "../db";
import { ProcessManager } from "./process-manager";
import { RunService } from "./run-service";
import type { PipelineGraph } from "../types";

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
    const workspacePath = input.workspacePath.trim();
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      throw new Error("Workspace path is required to generate a trigger.");
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
    const workspacePath = triggerState.workspacePath?.trim();
    if (!workspacePath || !fs.existsSync(workspacePath)) {
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
    };

    if (config.type === "script_poll") {
      watcher.timer = setInterval(() => {
        void this.pollWatcher(watcher.key);
      }, config.intervalSeconds * 1000);
    } else {
      this.webhookIndex.set(config.token, watcher.key);
    }

    this.watchers.set(watcher.key, watcher);
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
    const started = await this.runService.startRun(watcher.pipelineId, graph, {
      workspacePath: watcher.workspacePath,
      clearNodeChatContext: false,
    });

    watcher.lastFireAt = new Date().toISOString();
    watcher.lastRunId = started.runId;
    watcher.lastError = null;

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
    };
  }

  private toWatcherKey(pipelineId: string, nodeId: string): string {
    return `${pipelineId}:${nodeId}`;
  }
}
