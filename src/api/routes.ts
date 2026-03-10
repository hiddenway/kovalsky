import fs from "node:fs";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { PluginRegistry } from "../plugins/registry";
import type { PipelineService } from "../core/pipeline-service";
import type { RunService } from "../core/run-service";
import type { DatabaseService } from "../db";
import type { ProviderService } from "../providers/provider-service";
import type { EventBus } from "../core/event-bus";
import type { ToolchainService } from "../core/toolchain-service";
import type { SettingsService } from "../core/settings-service";
import type { PipelineGraph } from "../types";

interface RoutesDeps {
  version: string;
  runsDir: string;
  pluginRegistry: PluginRegistry;
  pipelineService: PipelineService;
  runService: RunService;
  db: DatabaseService;
  providerService: ProviderService;
  settingsService: SettingsService;
  eventBus: EventBus;
  toolchainService: ToolchainService;
}

const pipelineSchema = z.object({
  name: z.string().min(1),
  graph: z.object({
    nodes: z.array(
      z.object({
        id: z.string().min(1),
        agentId: z.string().min(1),
        goal: z.string().optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    edges: z.array(
      z.object({
        id: z.string().min(1),
        source: z.string().min(1),
        target: z.string().min(1),
      }),
    ),
  }),
});

const runStartSchema = z.object({
  pipelineId: z.string().min(1),
  overrides: z
    .object({
      workspacePath: z.string().min(1),
      maxParallelSteps: z.number().int().positive().optional(),
      stopOnFailure: z.boolean().optional(),
      timeoutMs: z.number().int().positive().optional(),
      credentialId: z.string().min(1).optional(),
      clearNodeChatContext: z.boolean().optional(),
    })
    .optional(),
});

const chatMessageSchema = z.object({
  content: z.string().min(1),
  role: z.enum(["user", "agent", "system"]).optional(),
  phase: z.enum(["pre_run", "run"]).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const chatReplySchema = z.object({
  content: z.string().min(1),
  rerunMode: z.enum(["node", "pipeline"]).optional(),
});

const providerConnectSchema = z.object({
  provider: z.enum(["openai", "codex", "openclaw"]),
  apiKey: z.string().min(1),
  label: z.string().optional(),
  authType: z.enum(["api_key", "oauth"]).optional(),
});

const settingsPatchSchema = z.object({
  agents: z.object({
    openclaw: z.object({
      providerMode: z.enum(["codex", "custom"]).optional(),
      customApiBaseUrl: z.string().optional(),
    }).optional(),
  }).optional(),
});

export async function registerRoutes(app: FastifyInstance<any, any, any, any>, deps: RoutesDeps): Promise<void> {
  app.get("/health", async () => ({ ok: true, version: deps.version }));

  app.get("/agents", async () => {
    return deps.pluginRegistry.listManifests().map((manifest) => ({
      id: manifest.id,
      version: manifest.version,
      title: manifest.title,
      runner: manifest.runner,
      inputs: manifest.inputs,
      outputs: manifest.outputs,
      permissions: manifest.permissions,
    }));
  });

  app.post("/agents/validate", async (request, reply) => {
    const body = z.object({ agentId: z.string().min(1), settings: z.record(z.string(), z.unknown()).optional() }).safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, errors: body.error.issues });
    }

    const plugin = deps.pluginRegistry.get(body.data.agentId);
    if (!plugin) {
      return reply.code(404).send({ ok: false, errors: ["Agent not found"] });
    }

    return { ok: true, errors: [] };
  });

  app.post("/pipelines", async (request, reply) => {
    const parsed = pipelineSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const pipeline = deps.pipelineService.createPipeline(parsed.data.name, parsed.data.graph as PipelineGraph);
      return { pipelineId: pipeline.id };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Validation error" });
    }
  });

  app.get("/pipelines/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const pipeline = deps.pipelineService.getPipeline(id);
    if (!pipeline) {
      return reply.code(404).send({ error: "Not found" });
    }
    return {
      id: pipeline.id,
      name: pipeline.name,
      graph: JSON.parse(pipeline.graph_json),
      createdAt: pipeline.created_at,
      updatedAt: pipeline.updated_at,
    };
  });

  app.put("/pipelines/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = pipelineSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const updated = deps.pipelineService.updatePipeline(id, parsed.data.name, parsed.data.graph as PipelineGraph);
      if (!updated) {
        return reply.code(404).send({ error: "Not found" });
      }
      return { pipelineId: updated.id };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Validation error" });
    }
  });

  app.post("/runs", async (request, reply) => {
    const parsed = runStartSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspacePath = parsed.data.overrides?.workspacePath?.trim();
    if (!workspacePath) {
      return reply.code(400).send({ error: "overrides.workspacePath is required" });
    }

    const pipeline = deps.db.getPipeline(parsed.data.pipelineId);
    if (!pipeline) {
      return reply.code(404).send({ error: "Workflow not found" });
    }

    const graph = JSON.parse(pipeline.graph_json) as PipelineGraph;
    const result = await deps.runService.startRun(parsed.data.pipelineId, graph, {
      workspacePath,
      maxParallelSteps: parsed.data.overrides?.maxParallelSteps,
      stopOnFailure: parsed.data.overrides?.stopOnFailure,
      timeoutMs: parsed.data.overrides?.timeoutMs,
      credentialId: parsed.data.overrides?.credentialId,
      clearNodeChatContext: parsed.data.overrides?.clearNodeChatContext,
    });

    return result;
  });

  app.get("/runs/:runId", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const snapshot = deps.runService.getRunSnapshot(runId);
    if (!snapshot.run) {
      return reply.code(404).send({ error: "Run not found" });
    }
    return snapshot;
  });

  app.get("/runs/:runId/plan", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const plan = deps.runService.getRunPlan(runId);
    if (!plan) {
      return reply.code(404).send({ error: "Run plan not found" });
    }
    return plan;
  });

  app.post("/runs/:runId/cancel", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const canceled = await deps.runService.cancelRun(runId);
    if (!canceled) {
      return reply.code(404).send({ error: "Run not active" });
    }
    return { ok: true };
  });

  app.get("/runs/:runId/artifacts", async (request) => {
    const runId = (request.params as { runId: string }).runId;
    return deps.db.getArtifactsByRun(runId);
  });

  app.get("/runs/:runId/nodes/:nodeId/chat", async (request, reply) => {
    const { runId, nodeId } = request.params as { runId: string; nodeId: string };
    const run = deps.db.getRun(runId);
    if (!run) {
      return reply.code(404).send({ error: "Run not found" });
    }
    return {
      runId,
      nodeId,
      messages: deps.runService.getNodeChat(runId, nodeId),
    };
  });

  app.post("/runs/:runId/nodes/:nodeId/chat", async (request, reply) => {
    const { runId, nodeId } = request.params as { runId: string; nodeId: string };
    const run = deps.db.getRun(runId);
    if (!run) {
      return reply.code(404).send({ error: "Run not found" });
    }

    const parsed = chatMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const message = deps.runService.appendNodeChat({
      runId,
      nodeId,
      content: parsed.data.content,
      role: parsed.data.role ?? "user",
      phase: parsed.data.phase ?? "pre_run",
      meta: parsed.data.meta,
    });

    return { ok: true, message };
  });

  app.post("/runs/:runId/nodes/:nodeId/chat/reply", async (request, reply) => {
    const { runId, nodeId } = request.params as { runId: string; nodeId: string };
    const run = deps.db.getRun(runId);
    if (!run) {
      return reply.code(404).send({ error: "Run not found" });
    }

    const parsed = chatReplySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const result = await deps.runService.replyNodeChat({
      runId,
      nodeId,
      content: parsed.data.content,
      rerunMode: parsed.data.rerunMode,
    });

    return {
      ok: true,
      userMessage: result.userMessage,
      message: result.agentMessage,
    };
  });

  app.get("/artifacts/:artifactId/download", async (request, reply) => {
    const artifactId = (request.params as { artifactId: string }).artifactId;
    const artifact = deps.db.getArtifact(artifactId);
    if (!artifact) {
      return reply.code(404).send({ error: "Artifact not found" });
    }

    if (!fs.existsSync(artifact.path)) {
      return reply.code(404).send({ error: "File missing" });
    }

    reply.header("content-type", artifact.mime);
    reply.header("content-length", String(artifact.size));
    reply.header("content-disposition", `attachment; filename=artifact-${artifact.id}`);
    return reply.send(fs.createReadStream(artifact.path));
  });

  app.get("/artifacts/:artifactId/preview", async (request, reply) => {
    const artifactId = (request.params as { artifactId: string }).artifactId;
    const artifact = deps.db.getArtifact(artifactId);
    if (!artifact) {
      return reply.code(404).send({ error: "Artifact not found" });
    }

    const preview = fs.readFileSync(artifact.path, "utf8");
    return {
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      mime: artifact.mime,
      preview,
      meta: artifact.meta_json ? JSON.parse(artifact.meta_json) : null,
    };
  });

  app.get("/runs/:runId/steps/:stepRunId/logs", async (request, reply) => {
    const params = request.params as { runId: string; stepRunId: string };
    const tail = Number((request.query as { tail?: string }).tail ?? 200);
    const step = deps.db.getStepRunsByRun(params.runId).find((record) => record.id === params.stepRunId);
    if (!step) {
      return reply.code(404).send({ error: "Step run not found" });
    }

    const logPath = `${deps.runsDir}/${params.runId}/steps/${params.stepRunId}/logs.txt`;
    if (!fs.existsSync(logPath)) {
      return { lines: [] };
    }

    const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
    return {
      lines: lines.slice(Math.max(0, lines.length - tail)),
    };
  });

  app.post("/providers/openai/connect", async (request, reply) => {
    const body = z.object({ apiKey: z.string().min(1), label: z.string().default("OpenAI") }).safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }

    try {
      const result = await deps.providerService.connectOpenAI(body.data.apiKey, body.data.label);
      return result;
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : "Failed to store key" });
    }
  });

  app.post("/providers/connect", async (request, reply) => {
    const body = providerConnectSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }

    try {
      const result = await deps.providerService.connectProvider(
        body.data.provider,
        body.data.apiKey,
        body.data.label ?? body.data.provider,
        body.data.authType ?? "api_key",
      );
      return result;
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : "Failed to store key" });
    }
  });

  app.get("/toolchain/agents", async () => {
    return deps.toolchainService.getBootstrapStatus();
  });

  app.post("/toolchain/agents/install", async () => {
    deps.toolchainService.startRequiredToolsInstall();
    return deps.toolchainService.getBootstrapStatus();
  });

  app.post("/toolchain/codex/login", async (_request, reply) => {
    try {
      await deps.toolchainService.startCodexLogin();
      return { ok: true };
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : "Failed to start codex login" });
    }
  });

  app.get("/toolchain/codex/auth", async () => {
    return deps.toolchainService.getCodexAuthStatus();
  });

  app.get("/providers/:provider/oauth-url", async (request, reply) => {
    const provider = ((request.params as { provider: string }).provider || "").trim().toLowerCase();
    if (provider !== "codex" && provider !== "openclaw") {
      return reply.code(400).send({ error: "Provider does not support OAuth URL endpoint" });
    }

    const envKey = provider === "codex" ? "KOVALSKY_CODEX_OAUTH_URL" : "KOVALSKY_OPENCLAW_OAUTH_URL";
    const oauthUrl = (process.env[envKey] ?? "").trim();
    return {
      provider,
      oauthUrl,
    };
  });

  app.get("/providers", async () => {
    return deps.providerService.listProviders().map((item) => ({
      id: item.id,
      provider: item.provider,
      label: item.label,
      createdAt: item.created_at,
      keychainRef: item.keychain_ref,
    }));
  });

  app.get("/settings", async () => {
    return deps.settingsService.getSettings();
  });

  app.put("/settings", async (request, reply) => {
    const body = settingsPatchSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }

    const next = deps.settingsService.updateSettings(body.data);
    return next;
  });

  app.delete("/providers/:credentialId", async (request) => {
    const credentialId = (request.params as { credentialId: string }).credentialId;
    await deps.providerService.deleteCredential(credentialId);
    return { ok: true };
  });

  app.get("/stream", { websocket: true }, (connection, request) => {
    const query = request.query as { runId?: string };

    const unsubscribe = deps.eventBus.subscribe((event) => {
      if (query.runId && event.runId !== query.runId) {
        return;
      }
      connection.send(JSON.stringify(event));
    });

    connection.on("close", () => {
      unsubscribe();
    });
  });
}
