const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");

const API_HOST = "127.0.0.1";
const API_PORT = 18787;
const UI_HOST = "127.0.0.1";
const UI_PORT = 13000;

const state = {
  backend: null,
  ui: null,
  quitting: false,
};

function appendTail(buffer, chunkText, maxLength = 6000) {
  const next = `${buffer}${chunkText}`;
  if (next.length <= maxLength) {
    return next;
  }
  return next.slice(next.length - maxLength);
}

function appDataDir() {
  return path.join(os.homedir(), ".kovalsky");
}

function appRootDir() {
  if (app.isPackaged) {
    return app.getAppPath();
  }
  return path.resolve(__dirname, "..");
}

function spawnNodeScript(scriptPath, options = {}) {
  const logs = {
    stdout: "",
    stderr: "",
  };
  const child = spawn(process.execPath, [scriptPath], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    logs.stdout = appendTail(logs.stdout, text);
    process.stdout.write(`[desktop:${path.basename(scriptPath)}] ${text}`);
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    logs.stderr = appendTail(logs.stderr, text);
    process.stderr.write(`[desktop:${path.basename(scriptPath)}] ${text}`);
  });

  child.__kovalskyLogs = logs;
  return child;
}

function waitForHttp(url, timeoutMs = 90_000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 500) {
          resolve();
          return;
        }
        scheduleNext(new Error(`Unexpected status ${response.statusCode ?? "unknown"} from ${url}`));
      });

      request.on("error", scheduleNext);
      request.setTimeout(2_000, () => {
        request.destroy(new Error(`Timeout while checking ${url}`));
      });
    };

    const scheduleNext = (error) => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(error);
        return;
      }
      setTimeout(probe, 500);
    };

    probe();
  });
}

function monitorChild(name, child) {
  child.once("exit", (code, signal) => {
    if (state.quitting) {
      return;
    }

    const reason = signal ? `signal ${signal}` : `code ${String(code ?? "unknown")}`;
    const logs = child.__kovalskyLogs || { stderr: "", stdout: "" };
    const tail = (logs.stderr || logs.stdout || "").trim();
    const details = tail ? `\n\nLast output:\n${tail.slice(-3000)}` : "";
    dialog.showErrorBox("Kovalsky stopped", `${name} process exited (${reason}).${details}`);
    app.quit();
  });
}

function stopChild(child) {
  if (!child || child.killed) {
    return;
  }
  child.kill("SIGTERM");
}

async function startServices() {
  const root = appRootDir();
  const runtimeNodeModules = path.join(root, ".runtime-node_modules");
  const runtimeNodeBin = path.join(runtimeNodeModules, ".bin");
  const nodePathParts = [];
  if (fs.existsSync(runtimeNodeModules)) {
    nodePathParts.push(runtimeNodeModules);
  }
  if (process.env.NODE_PATH) {
    nodePathParts.push(process.env.NODE_PATH);
  }
  const sharedNodePath = nodePathParts.join(path.delimiter);
  const sharedPath = fs.existsSync(runtimeNodeBin)
    ? `${runtimeNodeBin}${path.delimiter}${process.env.PATH ?? ""}`
    : (process.env.PATH ?? "");
  const backendScript = path.join(root, "dist", "index.js");
  const uiStandaloneRoot = path.join(root, "ui", ".next", "standalone");
  const uiScript = fs.existsSync(path.join(uiStandaloneRoot, "server.js"))
    ? path.join(uiStandaloneRoot, "server.js")
    : path.join(uiStandaloneRoot, "ui", "server.js");
  const uiCwd = path.dirname(uiScript);

  state.backend = spawnNodeScript(backendScript, {
    cwd: root,
    env: {
      NODE_ENV: "production",
      NODE_PATH: sharedNodePath,
      PATH: sharedPath,
      KOVALSKY_HOST: API_HOST,
      KOVALSKY_PORT: String(API_PORT),
      KOVALSKY_DISABLE_AUTH: "true",
      KOVALSKY_APPDATA_DIR: appDataDir(),
      KOVALSKY_TOOLCHAIN_ALLOW_SYSTEM: "false",
      KOVALSKY_ALLOWED_ORIGINS: `http://${UI_HOST}:${UI_PORT},http://localhost:${UI_PORT}`,
    },
  });
  monitorChild("Backend", state.backend);
  await waitForHttp(`http://${API_HOST}:${API_PORT}/health`);

  state.ui = spawnNodeScript(uiScript, {
    cwd: uiCwd,
    env: {
      NODE_ENV: "production",
      NODE_PATH: sharedNodePath,
      PATH: sharedPath,
      PORT: String(UI_PORT),
      HOSTNAME: UI_HOST,
      NEXT_PUBLIC_KOVALSKI_BACKEND_URL: `http://${API_HOST}:${API_PORT}`,
      KOVALSKY_APPDATA_DIR: appDataDir(),
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  monitorChild("UI", state.ui);
  await waitForHttp(`http://${UI_HOST}:${UI_PORT}`);
}

async function createMainWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 700,
    backgroundColor: "#09090b",
    title: "Kovalsky",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  await window.loadURL(`http://${UI_HOST}:${UI_PORT}/pipelines`);
}

ipcMain.handle("kovalsky:pick-workspace-directory", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select Workspace Folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

app.on("before-quit", () => {
  state.quitting = true;
  stopChild(state.ui);
  stopChild(state.backend);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createMainWindow();
  }
});

app.whenReady()
  .then(async () => {
    await startServices();
    await createMainWindow();
  })
  .catch((error) => {
    dialog.showErrorBox("Failed to start Kovalsky", error instanceof Error ? error.message : String(error));
    app.quit();
  });
