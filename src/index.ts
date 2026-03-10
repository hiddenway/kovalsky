import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import pino from "pino";
import { loadConfig } from "./config";
import { DatabaseService } from "./db";
import { ensurePairingToken, buildAuthPreHandler, isLocalhostAddress } from "./security";
import { PluginRegistry } from "./plugins/registry";
import { EventBus } from "./core/event-bus";
import { ArtifactStore } from "./artifacts/store";
import { ArtifactResolver } from "./artifacts/resolver";
import { ProcessManager } from "./core/process-manager";
import { AgentHost } from "./core/agent-host";
import { ToolchainService } from "./core/toolchain-service";
import { GraphExecutor } from "./core/graph-executor";
import { PipelineService } from "./core/pipeline-service";
import { ProviderService } from "./providers/provider-service";
import { RunService } from "./core/run-service";
import { SettingsService } from "./core/settings-service";
import { registerRoutes } from "./api/routes";
import { ensureDir } from "./utils/fs";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!isLocalhostAddress(config.host)) {
    throw new Error(`Gateway must bind localhost only. Current host: ${config.host}`);
  }

  ensureDir(config.appDataDir);
  ensureDir(config.runsDir);
  const pairingToken = ensurePairingToken(config.pairingTokenPath);

  const logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
  });

  const app = Fastify({
    loggerInstance: logger,
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) {
        cb(null, true);
        return;
      }
      if (config.allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(new Error("CORS origin denied"), false);
    },
  });

  await app.register(websocket);

  const db = new DatabaseService(config.dbPath);
  const eventBus = new EventBus();
  const pluginRegistry = new PluginRegistry(db, config.pluginsDir);
  await pluginRegistry.loadAll();

  const artifactStore = new ArtifactStore(db, config.runsDir);
  const artifactResolver = new ArtifactResolver(db);
  const processManager = new ProcessManager();
  const toolchainService = new ToolchainService(config.appDataDir, config.agentRuntimeMode, logger);
  const agentHost = new AgentHost(
    pluginRegistry,
    artifactStore,
    processManager,
    toolchainService,
    eventBus,
    logger,
    config.defaultStepTimeoutMs,
  );
  const graphExecutor = new GraphExecutor(db, pluginRegistry, artifactResolver, artifactStore, agentHost, eventBus, logger);
  const pipelineService = new PipelineService(db, pluginRegistry);
  const providerService = new ProviderService(db, config.appDataDir);
  const settingsService = new SettingsService(config.appDataDir);
  const runService = new RunService(db, graphExecutor, agentHost, providerService, settingsService, artifactStore, eventBus, logger);

  if (!config.disableAuth) {
    app.addHook("preHandler", buildAuthPreHandler(pairingToken));
  } else {
    logger.warn("Gateway auth is disabled (KOVALSKY_DISABLE_AUTH=true)");
  }

  await registerRoutes(app, {
    version: "0.1.0",
    runsDir: config.runsDir,
    pluginRegistry,
    pipelineService,
    runService,
    db,
    providerService,
    settingsService,
    eventBus,
    toolchainService,
  });

  app.addHook("onClose", async () => {
    db.close();
  });

  await app.listen({
    host: config.host,
    port: config.port,
  });

  logger.info({
    host: config.host,
    port: config.port,
    pairingTokenPath: config.pairingTokenPath,
  }, "Kovalsky Gateway started");
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
