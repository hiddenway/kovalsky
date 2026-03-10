import fs from "node:fs";
import path from "node:path";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import kill from "tree-kill";

export interface SpawnedProcessResult {
  exitCode: number;
}

type StreamName = "stdout" | "stderr";

export class ProcessManager {
  private readonly active = new Map<string, ChildProcess>();

  private commandExists(command: string, env: NodeJS.ProcessEnv): boolean {
    const probe = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(probe, [command], {
      env: {
        ...process.env,
        ...env,
      },
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

  private resolveNodeCommand(env: NodeJS.ProcessEnv): string {
    const override = env.KOVALSKY_NODE_PATH?.trim();
    if (override && fs.existsSync(override)) {
      return override;
    }

    if (process.execPath && fs.existsSync(process.execPath)) {
      return process.execPath;
    }

    const localNode = process.platform === "win32"
      ? path.join(path.dirname(process.execPath), "node.exe")
      : path.join(path.dirname(process.execPath), "node");
    if (fs.existsSync(localNode)) {
      return localNode;
    }

    if (this.commandExists("node", env)) {
      return "node";
    }

    return process.execPath;
  }

  async run(input: {
    key: string;
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    onStdout: (line: string) => void;
    onStderr: (line: string) => void;
    shouldTerminate?: (event: { stream: StreamName; line: string }) => boolean;
    successExitCodeOnEarlyTerminate?: number;
  }): Promise<SpawnedProcessResult> {
    return new Promise<SpawnedProcessResult>((resolve, reject) => {
      let settled = false;
      let earlyTerminationRequested = false;
      const settleResolve = (result: SpawnedProcessResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };
      const settleReject = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      let command = input.command;
      let args = input.args;
      let env = input.env;

      if (this.isNodeScriptCommand(input.command)) {
        command = this.resolveNodeCommand(input.env);
        args = [input.command, ...input.args];
        if (command === process.execPath) {
          env = {
            ...input.env,
            ELECTRON_RUN_AS_NODE: "1",
          };
        }
      }

      const child = spawn(command, args, {
        cwd: input.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.active.set(input.key, child);

      const requestEarlySuccessTermination = (): void => {
        if (settled || earlyTerminationRequested) {
          return;
        }
        earlyTerminationRequested = true;
        clearTimeout(timer);
        this.kill(input.key, { aggressive: true }).catch(() => {
          // noop
        }).finally(() => {
          settleResolve({
            exitCode: input.successExitCodeOnEarlyTerminate ?? 0,
          });
        });
      };

      const timer = setTimeout(() => {
        this.kill(input.key, { aggressive: true }).catch(() => {
          // noop
        }).finally(() => {
          this.active.delete(input.key);
          settleReject(new Error(`Step timed out after ${input.timeoutMs}ms`));
        });
      }, input.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) {
            input.onStdout(line);
            if (input.shouldTerminate?.({ stream: "stdout", line })) {
              requestEarlySuccessTermination();
            }
          }
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) {
            input.onStderr(line);
            if (input.shouldTerminate?.({ stream: "stderr", line })) {
              requestEarlySuccessTermination();
            }
          }
        }
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        this.active.delete(input.key);
        settleReject(error);
      });

      child.on("exit", (code) => {
        clearTimeout(timer);
        this.active.delete(input.key);
        if (earlyTerminationRequested) {
          settleResolve({
            exitCode: input.successExitCodeOnEarlyTerminate ?? 0,
          });
          return;
        }
        settleResolve({ exitCode: code ?? 1 });
      });
    });
  }

  async kill(key: string, options?: { aggressive?: boolean }): Promise<void> {
    const child = this.active.get(key);
    if (!child?.pid) {
      return;
    }

    await this.killTree(child.pid as number, "SIGTERM");
    if (options?.aggressive) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await this.killTree(child.pid as number, "SIGKILL");
    }
    this.active.delete(key);
  }

  async killAll(): Promise<void> {
    const keys = [...this.active.keys()];
    await Promise.all(keys.map((key) => this.kill(key, { aggressive: true })));
  }

  private async killTree(pid: number, signal: NodeJS.Signals): Promise<void> {
    await new Promise<void>((resolve) => {
      kill(pid, signal, () => resolve());
    });
  }
}
