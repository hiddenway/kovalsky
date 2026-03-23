import os from "node:os";
import path from "node:path";

export interface GatewayConfig {
  host: string;
  port: number;
  maxParallelSteps: number;
  defaultStepTimeoutMs: number;
  authUsername: string;
  authPassword: string;
  appDataDir: string;
  dbPath: string;
  runsDir: string;
  pairingTokenPath: string;
  pluginsDir: string;
  allowedOrigins: string[];
  disableAuth: boolean;
}

function getAppDataDir(): string {
  return path.join(os.homedir(), ".kovalsky");
}

export function loadConfig(): GatewayConfig {
  const appDataDir = process.env.KOVALSKY_APPDATA_DIR ?? getAppDataDir();
  const dbPath = process.env.KOVALSKY_DB_PATH ?? path.join(appDataDir, "gateway.db");
  const runsDir = process.env.KOVALSKY_RUNS_DIR ?? path.join(appDataDir, "runs");
  const pairingTokenPath = path.join(appDataDir, "pairing-token");
  const pluginsDir = process.env.KOVALSKY_PLUGINS_DIR ?? path.join(process.cwd(), "plugins");
  const allowedOriginsRaw = process.env.KOVALSKY_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000";
  const disableAuth = (process.env.KOVALSKY_DISABLE_AUTH ?? "true").trim().toLowerCase() !== "false";

  return {
    host: process.env.KOVALSKY_HOST ?? "127.0.0.1",
    port: Number(process.env.KOVALSKY_PORT ?? 8787),
    maxParallelSteps: Number(process.env.KOVALSKY_MAX_PARALLEL_STEPS ?? 3),
    defaultStepTimeoutMs: Number(process.env.KOVALSKY_DEFAULT_STEP_TIMEOUT_MS ?? 30 * 60 * 1000),
    authUsername: process.env.KOVALSKY_AUTH_USERNAME ?? "admin",
    authPassword: process.env.KOVALSKY_AUTH_PASSWORD ?? "admin",
    appDataDir,
    dbPath,
    runsDir,
    pairingTokenPath,
    pluginsDir,
    allowedOrigins: allowedOriginsRaw.split(",").map((item) => item.trim()).filter(Boolean),
    disableAuth,
  };
}
