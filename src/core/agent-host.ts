import fs from "node:fs";
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
        command: resolvedCommand,
        args: prepared.args,
      },
      "starting step command",
    );

    const openclawCompletion = params.agentId === "openclaw"
      ? createOpenClawCompletionDetector()
      : null;

    const runResult = await this.processManager.run({
      key: params.context.stepRunId,
      command: resolvedCommand,
      args: prepared.args,
      cwd: prepared.cwd ?? params.context.workspacePath,
      env: {
        ...params.context.env,
        ...prepared.env,
      },
      timeoutMs: params.timeoutMs ?? this.defaultStepTimeoutMs,
      onStdout: (line) => writeLog("stdout", line),
      onStderr: (line) => writeLog("stderr", line),
      shouldTerminate: ({ stream, line }) => {
        if (stream !== "stdout" || !openclawCompletion) {
          return false;
        }
        return openclawCompletion(line);
      },
      successExitCodeOnEarlyTerminate: openclawCompletion ? 0 : undefined,
    });

    logStream.end();

    const producedArtifacts = materializePlannedArtifacts(params.context, runResult.exitCode);

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
      exitCode: runResult.exitCode,
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

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const stripAnsi = (input: string): string => input.replace(/\x1B\[[0-9;]*m/g, "");

    await this.processManager.run({
      key: this.buildReportProcessKey(params.context.stepRunId),
      command: resolvedCommand,
      args: prepared.args,
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
      /^\s*[\[\]{}(),:]+\s*$/,
    ];
    const filtered = [...stdoutLines, ...stderrLines].filter((line) => !ignored.some((pattern) => pattern.test(line)));
    if (filtered.length === 0) {
      return "";
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
