import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type pino from "pino";
import { ensureDir } from "../utils/fs";
import { readCodexAuthState } from "../utils/codex-auth";

type KnownTool = "codex" | "openclaw";
type ToolState = "ready" | "missing" | "installing" | "error";
type ToolSource = "system" | "local" | "none";

export interface ToolStatus {
  tool: KnownTool;
  packageName: string;
  command: string;
  status: ToolState;
  source: ToolSource;
  error: string | null;
}

export interface ToolBootstrapStatus {
  runtimeMode: "auto" | "system";
  running: boolean;
  ready: boolean;
  tools: ToolStatus[];
}

export interface CodexAuthStatus {
  authenticated: boolean;
  expired: boolean;
  expiresAt: string | null;
}

const DEFAULT_PACKAGE_BY_TOOL: Record<KnownTool, string> = {
  codex: "@openai/codex",
  openclaw: "openclaw",
};

const PACKAGE_ENV_BY_TOOL: Record<KnownTool, string> = {
  codex: "KOVALSKY_CODEX_NPM_PACKAGE",
  openclaw: "KOVALSKY_OPENCLAW_NPM_PACKAGE",
};

const COMMAND_BY_TOOL: Record<KnownTool, string> = {
  codex: "codex",
  openclaw: "openclaw",
};

const REQUIRED_TOOLS: KnownTool[] = ["codex", "openclaw"];

function resolveToolByAgent(agentId: string): KnownTool | null {
  if (agentId === "codex" || agentId === "codex-cli") {
    return "codex";
  }
  if (agentId === "openclaw") {
    return "openclaw";
  }
  return null;
}

export class ToolchainService {
  private readonly installPromises = new Map<KnownTool, Promise<string>>();
  private readonly toolsRootDir: string;
  private readonly runtimeState = new Map<KnownTool, { state: ToolState; error: string | null }>();
  private bootstrapPromise: Promise<void> | null = null;

  constructor(
    appDataDir: string,
    private readonly runtimeMode: "auto" | "system",
    private readonly logger: pino.Logger,
  ) {
    this.toolsRootDir = path.join(appDataDir, "tools", "pnpm");
  }

  async ensureAgentCommand(agentId: string, command: string): Promise<string> {
    const tool = resolveToolByAgent(agentId);
    if (!tool) {
      return command;
    }

    const trimmedCommand = command.trim();
    const isDefaultCommand = trimmedCommand === COMMAND_BY_TOOL[tool];
    if (!isDefaultCommand) {
      if (this.commandExists(trimmedCommand)) {
        return trimmedCommand;
      }
      throw new Error(`Configured command "${trimmedCommand}" for ${tool} was not found.`);
    }

    if (this.runtimeMode === "system") {
      if (this.commandExists(trimmedCommand)) {
        return trimmedCommand;
      }
      throw new Error(`Required CLI "${command}" was not found in PATH (runtime mode: system).`);
    }

    const managed = this.getManagedBinaryPath(tool);
    if (managed) {
      this.ensureManagedNodeShim();
      return managed;
    }

    const bundled = this.getBundledBinaryPath(tool);
    if (bundled) {
      return bundled;
    }

    if (this.commandExists(trimmedCommand)) {
      return trimmedCommand;
    }

    return this.installTool(tool);
  }

  getBootstrapStatus(): ToolBootstrapStatus {
    const tools = REQUIRED_TOOLS.map((tool) => this.getToolStatus(tool));
    const ready = tools.every((item) => item.status === "ready");

    return {
      runtimeMode: this.runtimeMode,
      running: this.bootstrapPromise !== null,
      ready,
      tools,
    };
  }

  startRequiredToolsInstall(): void {
    if (this.runtimeMode === "system") {
      return;
    }
    if (this.bootstrapPromise) {
      return;
    }

    this.bootstrapPromise = (async () => {
      for (const tool of REQUIRED_TOOLS) {
        const current = this.getToolStatus(tool);
        if (current.status === "ready") {
          continue;
        }

        try {
          await this.installTool(tool);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Installation failed";
          this.runtimeState.set(tool, { state: "error", error: message });
          this.logger.error({ tool, err: error }, "failed to install required tool");
        }
      }
    })().finally(() => {
      this.bootstrapPromise = null;
    });
  }

  async startCodexLogin(): Promise<void> {
    const resolved = await this.ensureAgentCommand("codex-cli", COMMAND_BY_TOOL.codex);
    const invocation = this.resolveInvocation(resolved, []);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(invocation.command, [...invocation.args, "login"], {
        detached: true,
        stdio: "ignore",
        env: invocation.env,
      });

      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }

  getCodexAuthStatus(): CodexAuthStatus {
    const state = readCodexAuthState(process.env);
    return {
      authenticated: state.authenticated,
      expired: state.expired,
      expiresAt: state.expiresAt,
    };
  }

  private commandExists(command: string): boolean {
    const trimmed = command.trim();
    if (!trimmed) {
      return false;
    }

    const hasPathHints = trimmed.includes("/") || trimmed.includes("\\") || trimmed.startsWith(".");
    if (hasPathHints) {
      return fs.existsSync(path.resolve(trimmed));
    }

    const probe = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(probe, [trimmed], {
      stdio: "ignore",
    });
    return result.status === 0;
  }

  private isNodeScriptCommand(command: string): boolean {
    const ext = path.extname(command).toLowerCase();
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      return true;
    }
    if (!fs.existsSync(command)) {
      return false;
    }
    try {
      const fd = fs.openSync(command, "r");
      const buffer = Buffer.alloc(128);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      fs.closeSync(fd);
      const firstLine = buffer.subarray(0, read).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
      return /^#!.*\bnode\b/.test(firstLine);
    } catch {
      return false;
    }
  }

  private resolveNodeCommand(): string {
    const overridePath = (process.env.KOVALSKY_NODE_PATH ?? "").trim();
    if (overridePath && fs.existsSync(overridePath)) {
      return overridePath;
    }
    if (process.execPath && fs.existsSync(process.execPath)) {
      return process.execPath;
    }
    const candidate = process.platform === "win32"
      ? path.join(path.dirname(process.execPath), "node.exe")
      : path.join(path.dirname(process.execPath), "node");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    if (this.commandExists("node")) {
      return "node";
    }
    return process.execPath;
  }

  private resolveInvocation(command: string, args: string[]): {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  } {
    if (!this.isNodeScriptCommand(command)) {
      return {
        command,
        args,
        env: process.env,
      };
    }
    const nodeCommand = this.resolveNodeCommand();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
    };
    if (nodeCommand === process.execPath) {
      env.ELECTRON_RUN_AS_NODE = "1";
    }
    return {
      command: nodeCommand,
      args: [command, ...args],
      env,
    };
  }

  private getManagedBinaryPath(tool: KnownTool): string | null {
    const binaryName = process.platform === "win32" ? `${tool}.cmd` : tool;
    const binaryPath = path.join(this.toolsRootDir, "node_modules", ".bin", binaryName);
    if (fs.existsSync(binaryPath)) {
      return binaryPath;
    }
    return null;
  }

  private ensureManagedNodeShim(): void {
    const binDir = path.join(this.toolsRootDir, "node_modules", ".bin");
    ensureDir(binDir);

    const nodeCommand = this.resolveNodeCommand();
    const usesElectronNode = nodeCommand === process.execPath;

    if (process.platform === "win32") {
      const nodeCmdPath = path.join(binDir, "node.cmd");
      const nodeCmd = [
        "@echo off",
        "setlocal",
        usesElectronNode ? "if \"%ELECTRON_RUN_AS_NODE%\"==\"\" set \"ELECTRON_RUN_AS_NODE=1\"" : "",
        `\"${nodeCommand}\" %*`,
      ].filter(Boolean).join("\r\n");
      fs.writeFileSync(nodeCmdPath, `${nodeCmd}\r\n`, "utf8");
      return;
    }

    const nodeShimPath = path.join(binDir, "node");
    const nodeShim = [
      "#!/bin/sh",
      usesElectronNode ? "if [ -z \"$ELECTRON_RUN_AS_NODE\" ]; then export ELECTRON_RUN_AS_NODE=1; fi" : "",
      `exec \"${nodeCommand}\" \"$@\"`,
    ].filter(Boolean).join("\n");
    fs.writeFileSync(nodeShimPath, `${nodeShim}\n`, "utf8");
    fs.chmodSync(nodeShimPath, 0o755);
  }

  private resolvePnpmCommand(): string {
    const overridePath = (process.env.KOVALSKY_PNPM_PATH ?? "").trim();
    if (overridePath && fs.existsSync(overridePath)) {
      return overridePath;
    }

    const bundledPnpm = this.getBundledExecutablePath("pnpm");
    if (bundledPnpm) {
      return bundledPnpm;
    }

    if (this.commandExists("pnpm")) {
      return "pnpm";
    }

    const candidates = process.platform === "win32"
      ? [
        path.join(path.dirname(process.execPath), "pnpm.cmd"),
        path.join(process.cwd(), "node_modules", ".bin", "pnpm.cmd"),
      ]
      : [
        path.join(path.dirname(process.execPath), "pnpm"),
        path.join(process.cwd(), "node_modules", ".bin", "pnpm"),
        "/opt/homebrew/bin/pnpm",
        "/usr/local/bin/pnpm",
        "/usr/bin/pnpm",
      ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error("pnpm executable not found. Install pnpm or set KOVALSKY_PNPM_PATH.");
  }

  private resolveBundledPnpmScript(): string | null {
    const argvScriptDir = path.dirname(process.argv[1] ?? "");
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? "";
    const candidates = [
      path.join(process.cwd(), "node_modules", "pnpm", "bin", "pnpm.cjs"),
      path.join(argvScriptDir, "node_modules", "pnpm", "bin", "pnpm.cjs"),
      path.join(path.resolve(argvScriptDir, ".."), "node_modules", "pnpm", "bin", "pnpm.cjs"),
      path.join(resourcesPath, "app", "node_modules", "pnpm", "bin", "pnpm.cjs"),
      path.join(resourcesPath, "node_modules", "pnpm", "bin", "pnpm.cjs"),
    ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private resolveInstallInvocation(): { command: string; argsPrefix: string[]; env: NodeJS.ProcessEnv } {
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
    };

    const bundledPnpmScript = this.resolveBundledPnpmScript();
    if (bundledPnpmScript) {
      const nodeCommand = this.resolveNodeCommand();
      if (nodeCommand === process.execPath) {
        baseEnv.ELECTRON_RUN_AS_NODE = "1";
      }
      return {
        command: nodeCommand,
        argsPrefix: [bundledPnpmScript],
        env: baseEnv,
      };
    }

    try {
      return {
        command: this.resolvePnpmCommand(),
        argsPrefix: [],
        env: baseEnv,
      };
    } catch {
      if (this.commandExists("corepack")) {
        return {
          command: "corepack",
          argsPrefix: ["pnpm"],
          env: baseEnv,
        };
      }
      throw new Error("pnpm is unavailable. Install pnpm, enable corepack, or set KOVALSKY_PNPM_PATH.");
    }
  }

  private resolveInstallPathEnv(): string | undefined {
    const delimiter = process.platform === "win32" ? ";" : ":";
    const base = process.env.PATH?.split(delimiter).filter(Boolean) ?? [];
    const extra = process.platform === "win32"
      ? [
        path.dirname(process.execPath),
        "C:\\Program Files\\nodejs",
      ]
      : [
        path.dirname(process.execPath),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
      ];
    const merged = [...new Set([...extra, ...base])];
    return merged.join(delimiter);
  }

  private getToolStatus(tool: KnownTool): ToolStatus {
    const command = COMMAND_BY_TOOL[tool];
    const packageName = this.resolvePackageName(tool);
    const stateFromInstall = this.runtimeState.get(tool);

    if (this.runtimeMode === "system") {
      if (this.commandExists(command)) {
        return {
          tool,
          command,
          packageName,
          status: "ready",
          source: "system",
          error: null,
        };
      }
      return {
        tool,
        command,
        packageName,
        status: "missing",
        source: "none",
        error: null,
      };
    }

    if (this.getManagedBinaryPath(tool)) {
      return {
        tool,
        command,
        packageName,
        status: "ready",
        source: "local",
        error: null,
      };
    }

    const bundled = this.getBundledBinaryPath(tool);
    if (bundled) {
      return {
        tool,
        command,
        packageName,
        status: "ready",
        source: "local",
        error: null,
      };
    }

    if (this.commandExists(command)) {
      return {
        tool,
        command,
        packageName,
        status: "ready",
        source: "system",
        error: null,
      };
    }

    if (stateFromInstall?.state === "installing") {
      return {
        tool,
        command,
        packageName,
        status: "installing",
        source: "none",
        error: null,
      };
    }

    if (stateFromInstall?.state === "error") {
      return {
        tool,
        command,
        packageName,
        status: "error",
        source: "none",
        error: stateFromInstall.error,
      };
    }

    return {
      tool,
      command,
      packageName,
      status: "missing",
      source: "none",
      error: null,
    };
  }

  private resolvePackageName(tool: KnownTool): string {
    return process.env[PACKAGE_ENV_BY_TOOL[tool]]?.trim() || DEFAULT_PACKAGE_BY_TOOL[tool];
  }

  private getBundledBinaryPath(tool: KnownTool): string | null {
    return this.getBundledExecutablePath(COMMAND_BY_TOOL[tool]);
  }

  private getBundledExecutablePath(commandName: string): string | null {
    const binaryName = process.platform === "win32" ? `${commandName}.cmd` : commandName;
    const argvScriptDir = path.dirname(process.argv[1] ?? "");
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? "";
    const candidates = [
      path.join(process.cwd(), ".runtime-node_modules", ".bin", binaryName),
      path.join(process.cwd(), "node_modules", ".bin", binaryName),
      path.join(argvScriptDir, ".runtime-node_modules", ".bin", binaryName),
      path.join(path.resolve(argvScriptDir, ".."), ".runtime-node_modules", ".bin", binaryName),
      path.join(resourcesPath, "app", ".runtime-node_modules", ".bin", binaryName),
      path.join(resourcesPath, ".runtime-node_modules", ".bin", binaryName),
      path.join(resourcesPath, "app", "node_modules", ".bin", binaryName),
      path.join(resourcesPath, "node_modules", ".bin", binaryName),
    ];

    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private installTool(tool: KnownTool): Promise<string> {
    const inProgress = this.installPromises.get(tool);
    if (inProgress) {
      return inProgress;
    }

    const installPromise = (async () => {
      ensureDir(this.toolsRootDir);
      const packageName = this.resolvePackageName(tool);
      const installInvocation = this.resolveInstallInvocation();
      this.runtimeState.set(tool, { state: "installing", error: null });
      this.logger.info(
        { tool, packageName, installCommand: installInvocation.command, argsPrefix: installInvocation.argsPrefix },
        "tool not found; installing local CLI runtime",
      );
      let stdout = "";
      let stderr = "";

      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(
          installInvocation.command,
          [
            ...installInvocation.argsPrefix,
            "add",
            "--dir",
            this.toolsRootDir,
            "--silent",
            "--save-prod",
            `${packageName}@latest`,
          ],
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...installInvocation.env,
              PATH: this.resolveInstallPathEnv(),
            },
          },
        );

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        child.once("error", reject);
        child.once("close", (code) => {
          resolve(code ?? 1);
        });
      });

      const installedPath = this.getManagedBinaryPath(tool);
      if (exitCode === 0 && installedPath) {
        this.ensureManagedNodeShim();
        this.runtimeState.set(tool, { state: "ready", error: null });
        this.logger.info({ tool, installedPath }, "tool installed for gateway");
        return installedPath;
      }

      const details = stderr.trim() || stdout.trim() || `${installInvocation.command} exit code: ${exitCode}`;
      this.runtimeState.set(tool, { state: "error", error: details });
      throw new Error(`Failed to auto-install ${tool}. ${details}`);
    })()
      .finally(() => {
        this.installPromises.delete(tool);
      });

    this.installPromises.set(tool, installPromise);
    return installPromise;
  }
}
