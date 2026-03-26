import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type pino from "pino";
import { ArtifactStore } from "../artifacts/store";
import { ProcessManager } from "./process-manager";
import { PluginRegistry } from "../plugins/registry";
import type { GatewayEvent } from "./event-bus";
import type { EventBus } from "./event-bus";
import type { StepExecutionContext } from "../types";
import { materializePlannedArtifacts } from "../artifacts/materializer";
import { ToolchainService } from "./toolchain-service";

function createOpenClawCompletionDetector(): (line: string) => boolean {
  let capturing = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let jsonBuffer = "";

  return (line: string): boolean => {
    const input = `${line}\n`;
    for (const char of input) {
      if (!capturing) {
        if (char !== "{") {
          continue;
        }
        capturing = true;
        depth = 1;
        inString = false;
        escaped = false;
        jsonBuffer = "{";
        continue;
      }

      jsonBuffer += char;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
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
        if (depth !== 0) {
          continue;
        }

        try {
          const parsed = JSON.parse(jsonBuffer) as { payloads?: unknown; meta?: unknown };
          const hasPayloads = Array.isArray(parsed.payloads);
          const hasMeta = !!parsed.meta && typeof parsed.meta === "object";
          if (hasPayloads && hasMeta) {
            return true;
          }
        } catch {
          // noop
        } finally {
          capturing = false;
          depth = 0;
          inString = false;
          escaped = false;
          jsonBuffer = "";
        }
      }
    }

    return false;
  };
}

function extractOpenClawFailureSignal(line: string): string | null {
  const normalized = line.trim();
  if (!normalized) {
    return null;
  }

  const failurePattern = /(browser failed|gateway closed|browser unavailable|browser tool unavailable|unable to open|failed to open)/i;
  if (!failurePattern.test(normalized)) {
    return null;
  }

  return normalized.length > 320 ? `${normalized.slice(0, 317)}...` : normalized;
}

type SemverTriplet = [number, number, number];

function parseSemverTriplet(raw: string): SemverTriplet | null {
  const match = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isSemverAtLeast(current: string, minimum: string): boolean {
  const left = parseSemverTriplet(current);
  const right = parseSemverTriplet(minimum);
  if (!left || !right) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) {
      return true;
    }
    if (left[index] < right[index]) {
      return false;
    }
  }
  return true;
}

function extractMinNodeVersion(range: string): string | null {
  const normalized = range.trim();
  if (!normalized) {
    return null;
  }

  const exact = normalized.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (exact) {
    return `${exact[1]}.${exact[2]}.${exact[3]}`;
  }

  const greaterOrEqual = normalized.match(/>=\s*v?(\d+)\.(\d+)\.(\d+)/);
  if (greaterOrEqual) {
    return `${greaterOrEqual[1]}.${greaterOrEqual[2]}.${greaterOrEqual[3]}`;
  }

  return null;
}

function resolveCommandPath(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.startsWith(".")) {
    const absolute = path.resolve(trimmed);
    return fs.existsSync(absolute) ? absolute : null;
  }

  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [trimmed], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }

  const firstLine = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return null;
  }

  return fs.existsSync(firstLine) ? firstLine : null;
}

function resolveOpenclawEntrypoint(command: string): { commandPath: string; entrypoint: string } | null {
  const commandPath = resolveCommandPath(command);
  if (!commandPath) {
    return null;
  }

  const realPath = fs.realpathSync(commandPath);
  const baseName = path.basename(realPath).toLowerCase();
  if (baseName === "openclaw.mjs") {
    return { commandPath, entrypoint: realPath };
  }

  return null;
}

function readRequiredNodeVersionForOpenclaw(entrypoint: string): string | null {
  const packagePath = path.join(path.dirname(entrypoint), "package.json");
  if (!fs.existsSync(packagePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { engines?: { node?: unknown } };
    if (!parsed.engines || typeof parsed.engines.node !== "string") {
      return null;
    }
    return extractMinNodeVersion(parsed.engines.node);
  } catch {
    return null;
  }
}

function readNodeVersion(nodeCommand: string): string | null {
  try {
    const output = execFileSync(nodeCommand, ["-p", "process.versions.node"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function collectNvmNodeCandidates(): string[] {
  const binaryName = process.platform === "win32" ? "node.exe" : "node";
  const root = path.join(os.homedir(), ".nvm", "versions", "node");
  if (!fs.existsSync(root)) {
    return [];
  }

  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      parsed: parseSemverTriplet(entry.name),
    }))
    .filter((item): item is { name: string; parsed: SemverTriplet } => Boolean(item.parsed))
    .sort((left, right) => {
      for (let index = 0; index < 3; index += 1) {
        if (left.parsed[index] > right.parsed[index]) {
          return -1;
        }
        if (left.parsed[index] < right.parsed[index]) {
          return 1;
        }
      }
      return 0;
    })
    .map((item) => path.join(root, item.name, "bin", binaryName))
    .filter((candidate) => fs.existsSync(candidate));

  return entries;
}

function resolveCompatibleNodeForOpenclaw(minVersion: string, preferredDir: string): string | null {
  const binaryName = process.platform === "win32" ? "node.exe" : "node";
  const candidates = [
    (process.env.KOVALSKY_OPENCLAW_NODE_PATH ?? "").trim(),
    (process.env.KOVALSKY_NODE_PATH ?? "").trim(),
    path.join(preferredDir, binaryName),
    "node",
    ...collectNvmNodeCandidates(),
  ].filter(Boolean);

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const version = readNodeVersion(candidate);
    if (!version) {
      continue;
    }
    if (isSemverAtLeast(version, minVersion)) {
      return candidate;
    }
  }

  return null;
}

function maybeWrapOpenclawWithCompatibleNode(command: string, args: string[]): { command: string; args: string[] } {
  const resolved = resolveOpenclawEntrypoint(command);
  if (!resolved) {
    return { command, args };
  }

  const requiredNodeVersion = readRequiredNodeVersionForOpenclaw(resolved.entrypoint);
  if (!requiredNodeVersion) {
    return { command, args };
  }

  if (isSemverAtLeast(process.versions.node, requiredNodeVersion)) {
    return { command, args };
  }

  const compatibleNode = resolveCompatibleNodeForOpenclaw(requiredNodeVersion, path.dirname(resolved.commandPath));
  if (!compatibleNode) {
    return { command, args };
  }

  return {
    command: compatibleNode,
    args: [resolved.entrypoint, ...args],
  };
}

export class AgentHost {
  constructor(
    private readonly pluginRegistry: PluginRegistry,
    private readonly artifactStore: ArtifactStore,
    private readonly processManager: ProcessManager,
    private readonly toolchainService: ToolchainService,
    private readonly eventBus: EventBus,
    private readonly logger: pino.Logger,
    private readonly defaultStepTimeoutMs: number,
  ) {}

  async runStep(params: {
    agentId: string;
    context: StepExecutionContext;
    timeoutMs?: number;
  }): Promise<{ exitCode: number; artifactIds: string[] }> {
    const plugin = this.pluginRegistry.get(params.agentId);
    if (!plugin) {
      throw new Error(`Agent ${params.agentId} not found`);
    }

    if (plugin.manifest.runner !== "cli") {
      throw new Error(`Runner type ${plugin.manifest.runner} is not implemented in MVP`);
    }

    const prepared = await plugin.adapter.prepareCommand(params.context);
    const resolvedCommand = await this.toolchainService.ensureAgentCommand(params.agentId, prepared.command);
    const invocation = maybeWrapOpenclawWithCompatibleNode(resolvedCommand, prepared.args);

    fs.mkdirSync(path.dirname(params.context.stepLogPath), { recursive: true });
    const logStream = fs.createWriteStream(params.context.stepLogPath, { flags: "a" });

    const writeLog = (prefix: "stdout" | "stderr", line: string): void => {
      const full = `[${prefix}] ${line}`;
      logStream.write(`${full}\n`);
      const event: GatewayEvent = {
        runId: params.context.runId,
        type: "log_line",
        at: new Date().toISOString(),
        payload: {
          stepRunId: params.context.stepRunId,
          line: full,
        },
      };
      this.eventBus.emit(event);
    };

    this.logger.info(
      {
        stepRunId: params.context.stepRunId,
        command: invocation.command,
        args: invocation.args,
      },
      "starting step command",
    );

    const openclawCompletion = params.agentId === "openclaw"
      ? createOpenClawCompletionDetector()
      : null;
    let openclawFailureSignal: string | null = null;

    const runResult = await this.processManager.run({
      key: params.context.stepRunId,
      command: invocation.command,
      args: invocation.args,
      cwd: prepared.cwd ?? params.context.workspacePath,
      env: {
        ...params.context.env,
        ...prepared.env,
      },
      timeoutMs: params.timeoutMs ?? this.defaultStepTimeoutMs,
      onStdout: (line) => {
        writeLog("stdout", line);
        if (params.agentId === "openclaw" && !openclawFailureSignal) {
          openclawFailureSignal = extractOpenClawFailureSignal(line);
        }
      },
      onStderr: (line) => {
        writeLog("stderr", line);
        if (params.agentId === "openclaw" && !openclawFailureSignal) {
          openclawFailureSignal = extractOpenClawFailureSignal(line);
        }
      },
      shouldTerminate: ({ stream, line }) => {
        if (stream !== "stdout" || !openclawCompletion) {
          return false;
        }
        return openclawCompletion(line);
      },
      successExitCodeOnEarlyTerminate: openclawCompletion ? 0 : undefined,
    });

    let effectiveExitCode = runResult.exitCode;
    if (params.agentId === "openclaw" && effectiveExitCode === 0 && openclawFailureSignal) {
      writeLog(
        "stderr",
        `OpenClaw reported browser/tool failure, marking step as failed: ${openclawFailureSignal}`,
      );
      effectiveExitCode = 1;
    }

    logStream.end();

    const producedArtifacts = materializePlannedArtifacts(params.context, effectiveExitCode);

    const stored = producedArtifacts.map((artifact) =>
      this.artifactStore.createArtifactFromFile({
        runId: params.context.runId,
        stepRunId: params.context.stepRunId,
        type: artifact.type,
        title: artifact.title,
        sourceFilePath: artifact.filePath,
        mime: artifact.mime,
        meta: artifact.meta,
      }),
    );

    for (const artifact of stored) {
      this.eventBus.emit({
        runId: params.context.runId,
        type: "artifact_created",
        at: new Date().toISOString(),
        payload: {
          artifactId: artifact.id,
          type: artifact.type,
          title: artifact.title,
          preview: artifact.meta_json ? JSON.parse(artifact.meta_json) : null,
        },
      });
    }

    return {
      exitCode: effectiveExitCode,
      artifactIds: stored.map((artifact) => artifact.id),
    };
  }

  async runNodeReport(params: {
    agentId: string;
    context: StepExecutionContext;
    timeoutMs?: number;
  }): Promise<string> {
    const plugin = this.pluginRegistry.get(params.agentId);
    if (!plugin || plugin.manifest.runner !== "cli") {
      return "";
    }

    const prepared = await plugin.adapter.prepareCommand({
      ...params.context,
      reportMode: true,
    });
    const resolvedCommand = await this.toolchainService.ensureAgentCommand(params.agentId, prepared.command);
    const invocation = maybeWrapOpenclawWithCompatibleNode(resolvedCommand, prepared.args);

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const stripAnsi = (input: string): string => input.replace(/\x1B\[[0-9;]*m/g, "");

    await this.processManager.run({
      key: this.buildReportProcessKey(params.context.stepRunId),
      command: invocation.command,
      args: invocation.args,
      cwd: prepared.cwd ?? params.context.workspacePath,
      env: {
        ...params.context.env,
        ...prepared.env,
      },
      timeoutMs: Math.max(15_000, Math.min(params.timeoutMs ?? this.defaultStepTimeoutMs, 180_000)),
      onStdout: (line) => {
        const cleaned = stripAnsi(line).trim();
        if (cleaned) {
          stdoutLines.push(cleaned);
        }
      },
      onStderr: (line) => {
        const cleaned = stripAnsi(line).trim();
        if (cleaned) {
          stderrLines.push(cleaned);
        }
      },
    });

    const ignored = [
      /^\[tools\]/i,
      /^command exited with code/i,
      /^warning[:\s]/i,
    ];
    if (params.agentId !== "trigger") {
      ignored.push(/^\s*[\[\]{}(),:]+\s*$/);
    }
    const filtered = [...stdoutLines, ...stderrLines].filter((line) => !ignored.some((pattern) => pattern.test(line)));
    if (filtered.length === 0) {
      return "";
    }

    if (params.agentId === "trigger") {
      // Trigger poll parser needs complete output context to extract JSON decision.
      // Trimming by the last N lines can cut off the leading part of JSON and
      // produce false "missing JSON decision" failures.
      const full = filtered.join("\n");
      const maxChars = 120_000;
      return full.length > maxChars ? full.slice(-maxChars) : full;
    }

    return filtered.slice(-24).join("\n");
  }

  private buildReportProcessKey(stepRunId: string): string {
    return `report:${stepRunId}`;
  }

  async cancelStep(stepRunId: string): Promise<void> {
    await Promise.allSettled([
      this.processManager.kill(stepRunId, { aggressive: true }),
      this.processManager.kill(this.buildReportProcessKey(stepRunId), { aggressive: true }),
    ]);
  }

  async cancelAll(): Promise<void> {
    await this.processManager.killAll();
  }
}
