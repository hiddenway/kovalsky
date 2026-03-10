import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentPlugin } from "../types";
import type { StepExecutionContext } from "../../types";
import { extractUrlsFromText, normalizeUrlCandidate } from "../../utils/url";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(input: unknown): string[] {
  return Array.isArray(input) ? input.map(String) : [];
}

function asString(input: unknown): string {
  return typeof input === "string" ? input : "";
}

function formatChatHistory(ctx: StepExecutionContext): string {
  const history = ctx.reportContext?.chatHistory ?? [];
  if (history.length === 0) {
    return "";
  }

  return history
    .map((item, index) => {
      const role = item.role === "agent" ? "Assistant" : item.role === "user" ? "User" : "System";
      return `${index + 1}. ${role}: ${item.content.trim()}`;
    })
    .join("\n");
}

function normalizeKey(input: string): string {
  return input.trim().toLowerCase();
}

function isUrlLikeKey(input: string): boolean {
  const key = normalizeKey(input);
  return key === "url" || key.endsWith("_url") || key.endsWith("url");
}

function extractUrlsFromArtifact(input: { path: string; meta_json: string | null }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null): void => {
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    out.push(value);
  };

  if (input.meta_json) {
    try {
      const meta = JSON.parse(input.meta_json) as { url?: unknown; urls?: unknown };
      if (Array.isArray(meta.urls)) {
        for (const item of meta.urls) {
          if (typeof item === "string") {
            push(normalizeUrlCandidate(item));
          }
        }
      }
      if (typeof meta.url === "string" && meta.url.trim()) {
        push(normalizeUrlCandidate(meta.url));
      }
    } catch {
      // ignore invalid meta
    }
  }

  push(normalizeUrlCandidate(input.path));
  if (fs.existsSync(input.path)) {
    try {
      const content = fs.readFileSync(input.path, "utf8");
      for (const item of extractUrlsFromText(content)) {
        push(item);
      }
    } catch {
      // ignore unreadable input artifact
    }
  }

  return out;
}

function collectResolvedUrlCandidates(ctx: StepExecutionContext): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null): void => {
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    out.push(value);
  };

  const prioritized = Object.entries(ctx.resolvedInputs.inputsByType).sort(([left], [right]) => {
    const leftUrl = isUrlLikeKey(left);
    const rightUrl = isUrlLikeKey(right);
    if (leftUrl === rightUrl) {
      return 0;
    }
    return leftUrl ? -1 : 1;
  });

  for (const [, artifacts] of prioritized) {
    for (const artifact of artifacts) {
      for (const url of extractUrlsFromArtifact(artifact)) {
        push(url);
      }
    }
  }

  for (const handoff of ctx.resolvedInputs.handoffs) {
    for (const url of handoff.packet?.urls ?? []) {
      push(normalizeUrlCandidate(url));
    }
    const textCandidates = [
      handoff.packet?.summary ?? "",
      handoff.packet?.context ?? "",
      ...(handoff.packet?.launchHints ?? []),
      ...(handoff.packet?.handoffTo ?? []).map((item) => item.context),
      ...(handoff.packet?.handoffTo ?? []).flatMap((item) => item.launchHints),
    ];
    for (const text of textCandidates) {
      for (const url of extractUrlsFromText(text)) {
        push(url);
      }
    }
  }

  return out;
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const next = value.trim();
    if (!next || seen.has(next)) {
      continue;
    }
    seen.add(next);
    out.push(next);
  }
  return out;
}

function collectHandoffLines(ctx: StepExecutionContext): string[] {
  const out: string[] = [];
  for (const handoff of ctx.resolvedInputs.handoffs) {
    const chunks: string[] = [];
    if (handoff.packet?.summary?.trim()) {
      chunks.push(handoff.packet.summary.trim());
    }
    const targeted = (handoff.packet?.handoffTo ?? [])
      .filter((item) => item.nodeId === ctx.nodeId)
      .map((item) => item.context.trim())
      .filter(Boolean);
    chunks.push(...targeted);
    if (chunks.length > 0) {
      out.push(`From ${handoff.fromNodeId}: ${chunks.join(" | ")}`);
    }
  }
  return out;
}

function buildFullHandoffDump(ctx: StepExecutionContext): string {
  if (ctx.resolvedInputs.handoffs.length === 0) {
    return "";
  }

  return ctx.resolvedInputs.handoffs
    .map((handoff, index) => {
      const payload = handoff.packet ?? {
        fromNodeId: handoff.fromNodeId,
        missingPacket: true,
        artifactPath: handoff.artifact.path,
      };
      return `Handoff ${index + 1} from ${handoff.fromNodeId}:\n${JSON.stringify(payload, null, 2)}`;
    })
    .join("\n\n");
}

function collectLaunchHints(ctx: StepExecutionContext): string[] {
  const hints: string[] = [];
  hints.push(...ctx.plannedNode.handoffTo.flatMap((item) => item.launchHints));
  for (const handoff of ctx.resolvedInputs.handoffs) {
    hints.push(...(handoff.packet?.launchHints ?? []));
    const targeted = (handoff.packet?.handoffTo ?? []).filter((item) => item.nodeId === ctx.nodeId);
    hints.push(...targeted.flatMap((item) => item.launchHints));
  }
  return uniqueStrings(hints);
}

function collectWorkspaceLaunchHints(ctx: StepExecutionContext): string[] {
  const packageJsonPath = path.join(ctx.workspacePath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const scripts = parsed.scripts ?? {};
    const out: string[] = [];

    const pushScriptHint = (script: string, preferred: string): void => {
      if (typeof scripts[script] !== "string") {
        return;
      }
      out.push(`${preferred} (script: ${script})`);
    };

    pushScriptHint("dev", "pnpm dev");
    pushScriptHint("start", "pnpm start");
    pushScriptHint("preview", "pnpm preview");

    if (out.length === 0) {
      return [];
    }

    out.push("If pnpm is unavailable, fallback to npm/yarn equivalent command.");
    return out;
  } catch {
    return [];
  }
}

function shouldAllowServerStopActions(ctx: StepExecutionContext): boolean {
  const text = [
    ctx.goal,
    ctx.plannedNode.goalAddendum ?? "",
    ctx.plannedNode.handoffContext ?? "",
  ]
    .join(" ")
    .toLowerCase();

  const keywords = [
    "stop server",
    "shutdown server",
    "shut down server",
    "terminate server",
    "disable server",
    "close server",
    "free port",
    "release port",
    "останови сервер",
    "остановить сервер",
    "отключи сервер",
    "отключить сервер",
    "выключи сервер",
    "выключить сервер",
    "закрой сервер",
    "закрыть сервер",
    "освободи порт",
    "освободить порт",
  ];

  return keywords.some((keyword) => text.includes(keyword));
}

function shouldRequireBrowserChecks(ctx: StepExecutionContext): boolean {
  const text = [
    ctx.goal,
    ctx.plannedNode.goalAddendum ?? "",
    ctx.plannedNode.handoffContext ?? "",
  ]
    .join(" ")
    .toLowerCase();

  const browserKeywords = [
    "browser",
    "playwright",
    "blackbox",
    "visual",
    "ui check",
    "ui test",
    "frontend qa",
    "page check",
    "open in browser",
    "manual qa",
    "e2e",
    "end-to-end",
    "проверь в браузере",
    "проверка в браузере",
    "визуально проверь",
    "ui-проверка",
    "ui проверка",
  ];

  return browserKeywords.some((keyword) => text.includes(keyword));
}

function buildAgentMessage(ctx: StepExecutionContext): string {
  const lines: string[] = [];
  const persistBackgroundProcesses = ctx.settings.persistBackgroundProcesses === true;
  const allowServerStopActions = shouldAllowServerStopActions(ctx);
  const requireBrowserChecks = shouldRequireBrowserChecks(ctx);
  if (ctx.goal.trim()) {
    lines.push(ctx.goal.trim());
  }
  if (ctx.plannedNode.goalAddendum?.trim()) {
    lines.push(`Planner addendum: ${ctx.plannedNode.goalAddendum.trim()}`);
  }
  if (ctx.plannedNode.handoffContext?.trim()) {
    lines.push(`Planner handoff context: ${ctx.plannedNode.handoffContext.trim()}`);
  }
  const urlCandidates = collectResolvedUrlCandidates(ctx);
  if (urlCandidates.length > 0) {
    lines.push(`Resolved URL candidates:\n${urlCandidates.slice(0, 8).map((url) => `- ${url}`).join("\n")}`);
  } else {
    lines.push("No explicit URL candidates were resolved. Discover target URL from workspace and upstream handoff.");
  }
  const dynamicInputs = Object.entries(ctx.resolvedInputs.inputsByType)
    .map(([type, artifacts]) => `${type}: ${artifacts.length}`)
    .sort();
  if (dynamicInputs.length > 0) {
    lines.push(`Resolved upstream inputs: ${dynamicInputs.join(", ")}`);
  }
  const handoffLines = collectHandoffLines(ctx);
  if (handoffLines.length > 0) {
    lines.push(`Upstream handoff:\n${handoffLines.join("\n")}`);
  }
  const fullHandoffDump = buildFullHandoffDump(ctx);
  if (fullHandoffDump) {
    lines.push(`Full upstream handoff payloads (passthrough mode):\n${fullHandoffDump}`);
  }
  const launchHints = collectLaunchHints(ctx);
  if (launchHints.length > 0) {
    lines.push(`Launch hints:\n${launchHints.map((line) => `- ${line}`).join("\n")}`);
  }
  const workspaceLaunchHints = collectWorkspaceLaunchHints(ctx);
  if (workspaceLaunchHints.length > 0) {
    lines.push(`Workspace start hints:\n${workspaceLaunchHints.map((line) => `- ${line}`).join("\n")}`);
  }
  if (persistBackgroundProcesses) {
    lines.push("Background service persistence is ENABLED for this node.");
    lines.push("If user requests a local server that must stay available after this step, run it as detached/background process.");
    lines.push("Report exact local URL and port, and mention how you verified reachability.");
    lines.push("Avoid keeping the step blocked by foreground server process.");
  } else {
    lines.push("Execution is isolated per step. Do not rely on processes from previous steps.");
  }
  if (allowServerStopActions) {
    lines.push("User explicitly asked to stop server/background services.");
    lines.push("Stop only the target process for this workspace/port using precise PID/port-based commands.");
    lines.push("Never run broad kill commands (killall/pkill without explicit PID/port filter).");
    lines.push("Confirm shutdown by proving the previous local URL/port no longer responds.");
  } else {
    lines.push("Do not stop or kill existing processes in workspace. Never run pkill/killall/kill on dev servers.");
    lines.push("If an existing app URL is already reachable, reuse it and skip starting a new server.");
    lines.push("If you must start a server, use a separate port and leave existing ports/processes untouched.");
    lines.push("If local app needs to run, start it in this step and verify URL is reachable with lightweight checks (curl/lsof) before browser checks.");
  }
  if (requireBrowserChecks) {
    lines.push("Run browser blackbox checks and finish in one response with summary, issues, reproduction, severity.");
  } else {
    lines.push("Do not launch interactive browser sessions unless the task explicitly asks for browser/UI checks.");
  }
  return lines.join("\n");
}

function buildReportMessage(ctx: StepExecutionContext): string {
  const urlCandidates = collectResolvedUrlCandidates(ctx);
  const customTemplate = asString(ctx.settings.reportPromptTemplate).trim();
  if (customTemplate) {
    return customTemplate
      .replaceAll("{{goal}}", ctx.goal || "(empty)")
      .replaceAll("{{followupPrompt}}", ctx.reportContext?.followupPrompt?.trim() || "")
      .replaceAll("{{stepStatus}}", ctx.reportContext?.stepStatus || "")
      .replaceAll("{{stepError}}", ctx.reportContext?.stepError || "")
      .replaceAll("{{artifacts}}", ctx.reportContext?.artifactTitles?.join(", ") || "")
      .replaceAll("{{logTail}}", ctx.reportContext?.logTail?.join("\n") || "")
      .replaceAll("{{targetUrl}}", "")
      .replaceAll("{{urls}}", urlCandidates.join(", "))
      .replaceAll("{{chatHistory}}", formatChatHistory(ctx));
  }

  const lines: string[] = [];
  lines.push("You are a helpful assistant in node chat.");
  lines.push("No tool calls, commands, or file edits. Plain text only.");
  lines.push("Do not output code blocks, snippets, diffs, HTML/CSS/JS, or shell commands.");
  lines.push("Explain in natural language and keep focus on what to do next.");
  lines.push(`Original goal: ${ctx.goal || "(empty)"}`);
  const chatHistory = formatChatHistory(ctx);
  if (chatHistory) {
    lines.push(`Full chat history:\n${chatHistory}`);
  }
  if (ctx.reportContext?.followupPrompt?.trim()) {
    lines.push(`Follow-up user request: ${ctx.reportContext.followupPrompt.trim()}`);
    lines.push("Use the full chat history and the existing step context when answering.");
    lines.push("Reply in the same language as the follow-up user request.");
    lines.push("Do not repeat or quote previous answers verbatim unless the user explicitly asks.");
  }
  if (urlCandidates.length > 0) {
    lines.push(`Resolved URL candidates: ${urlCandidates.slice(0, 8).join(", ")}`);
  }
  if (ctx.reportContext?.stepStatus) {
    lines.push(`Step status: ${ctx.reportContext.stepStatus}`);
  }
  if (ctx.reportContext?.stepError) {
    lines.push(`Step error: ${ctx.reportContext.stepError}`);
  }
  if (ctx.reportContext?.artifactTitles?.length) {
    lines.push(`Artifacts: ${ctx.reportContext.artifactTitles.join(", ")}`);
  }
  if (ctx.reportContext?.logTail?.length) {
    lines.push(`Log tail:\n${ctx.reportContext.logTail.map((line) => `- ${line}`).join("\n")}`);
  }
  lines.push("Answer directly and naturally like an assistant, not a rigid report.");
  lines.push("If data is insufficient, ask one concise clarifying question.");
  lines.push("At the very end add one strict machine-readable line:");
  lines.push("KOVALSKY_DECISION: rerun or KOVALSKY_DECISION: no_rerun");
  lines.push("Use rerun only when the user clearly asks to perform edits/actions now.");
  return lines.join("\n");
}

function detectDefaultAgent(profile: string | null): string | null {
  try {
    const args = [];
    if (profile) {
      args.push("--profile", profile);
    }
    args.push("agents", "list");
    const output = execFileSync("openclaw", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const defaultMatch = output.match(/^\-\s+([^\n(]+?)\s+\(default\)\s*$/m);
    if (defaultMatch?.[1]?.trim()) {
      return defaultMatch[1].trim();
    }
    const firstMatch = output.match(/^\-\s+([^\n(]+?)\s*(?:\(|$)/m);
    if (firstMatch?.[1]?.trim()) {
      return firstMatch[1].trim();
    }
    return null;
  } catch {
    return null;
  }
}

function buildSessionId(ctx: StepExecutionContext, suffix = ""): string {
  const normalizedSuffix = suffix ? suffix.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 12) : "";
  const key = `${ctx.runId}|${ctx.nodeId}|${ctx.stepRunId}|${normalizedSuffix}`;
  const digest = createHash("sha1").update(key).digest("hex");
  const composed = normalizedSuffix ? `kgw-${digest}-${normalizedSuffix}` : `kgw-${digest}`;
  return composed.slice(0, 64);
}

function ensureAgentSessionId(args: string[], sessionId: string): string[] {
  if (args.length === 0 || args[0] !== "agent") {
    return args;
  }
  if (args.includes("--session-id")) {
    return args;
  }
  return [...args, "--session-id", sessionId];
}

function extractAgentIdFromArgs(args: string[]): string | null {
  if (args.length === 0 || args[0] !== "agent") {
    return null;
  }
  const index = args.findIndex((item) => item === "--agent");
  if (index < 0) {
    return null;
  }
  const value = args[index + 1];
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

type PreparedOpenClawState = {
  stateDir: string;
  isolated: boolean;
};

function shouldSkipStatePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized) {
    return false;
  }
  if (normalized === "sessions" || normalized.startsWith("sessions/")) {
    return true;
  }
  if (normalized.endsWith(".lock")) {
    return true;
  }
  return false;
}

function copyOpenClawStateSansSessions(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir)) {
    return;
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (shouldSkipStatePath(entry.name)) {
      continue;
    }

    if (entry.isDirectory()) {
      copyOpenClawStateSansSessions(sourcePath, targetPath);
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isObjectRecord(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function writeJsonObject(filePath: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function applyWorkspaceOverrideToState(input: { stateDir: string; workspacePath: string; agentId: string | null }): void {
  const stateDir = input.stateDir.trim();
  const workspacePath = input.workspacePath.trim();
  if (!stateDir || !workspacePath) {
    return;
  }

  const configPath = path.join(stateDir, "openclaw.json");
  const config = readJsonObject(configPath);
  const agents = isObjectRecord(config.agents) ? { ...config.agents } : {};
  const defaults = isObjectRecord(agents.defaults) ? { ...agents.defaults } : {};
  defaults.workspace = workspacePath;
  agents.defaults = defaults;

  const normalizedAgentId = (input.agentId ?? "").trim();
  if (normalizedAgentId) {
    const rawList = Array.isArray(agents.list) ? agents.list : [];
    const nextList = rawList.map((item) => (isObjectRecord(item) ? { ...item } : item));
    const existingIndex = nextList.findIndex((entry) => {
      if (!isObjectRecord(entry) || typeof entry.id !== "string") {
        return false;
      }
      return entry.id.trim().toLowerCase() === normalizedAgentId.toLowerCase();
    });

    if (existingIndex >= 0 && isObjectRecord(nextList[existingIndex])) {
      nextList[existingIndex] = {
        ...nextList[existingIndex],
        id: normalizedAgentId,
        workspace: workspacePath,
      };
    } else {
      nextList.push({
        id: normalizedAgentId,
        workspace: workspacePath,
      });
    }

    agents.list = nextList;
  }

  config.agents = agents;
  writeJsonObject(configPath, config);
}

function prepareIsolatedStateDir(ctx: StepExecutionContext): PreparedOpenClawState {
  const sharedStateDir = (ctx.env.OPENCLAW_STATE_DIR ?? "").trim();
  if (!sharedStateDir) {
    return { stateDir: "", isolated: false };
  }

  const isolatedStateDir = path.join(ctx.stepDir, "openclaw-state");
  try {
    copyOpenClawStateSansSessions(sharedStateDir, isolatedStateDir);
    return { stateDir: isolatedStateDir, isolated: true };
  } catch {
    return { stateDir: sharedStateDir, isolated: false };
  }
}

export const openclawPlugin: AgentPlugin = {
  manifest: {
    id: "openclaw",
    version: "1.0.0",
    title: "OpenClaw",
    runner: "cli",
    inputs: [],
    outputs: [],
    configSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        useProfile: { type: "boolean" },
        profile: { type: "string", enum: ["smoke", "full"] },
        mode: { type: "string", enum: ["agent-local", "raw"] },
        agentId: { type: "string" },
        thinking: { type: "string", enum: ["off", "minimal", "low", "medium", "high"] },
        timeoutSeconds: { type: "number" },
        passGoalAsArg: { type: "boolean" },
        goalFlag: { type: "string" },
        reportPromptTemplate: { type: "string" },
        persistBackgroundProcesses: { type: "boolean" },
      },
    },
    permissions: {
      filesystem: true,
      network: true,
      process: true,
    },
  },
  adapter: {
    async prepareCommand(ctx) {
      const command = typeof ctx.settings.command === "string" ? ctx.settings.command : "openclaw";
      const rootArgs: string[] = [];
      const statePrep = prepareIsolatedStateDir(ctx);
      const isolatedStateDir = statePrep.stateDir;
      const useProfile = ctx.settings.useProfile === true;
      const profile = useProfile && typeof ctx.settings.profile === "string" && ctx.settings.profile.trim()
        ? ctx.settings.profile.trim()
        : null;
      if (profile) {
        rootArgs.push("--profile", profile);
      }

      const configuredArgs = asStringArray(ctx.settings.args);
      const mode = typeof ctx.settings.mode === "string" ? ctx.settings.mode : "agent-local";
      let commandArgs: string[];
      let selectedAgentId: string | null = null;

      if (ctx.reportMode) {
        const configuredAgent = typeof ctx.settings.agentId === "string" && ctx.settings.agentId.trim()
          ? ctx.settings.agentId.trim()
          : null;
        const agentId = configuredAgent ?? detectDefaultAgent(profile) ?? "main";
        selectedAgentId = agentId;
        const sessionId = buildSessionId(ctx, "-report");
        commandArgs = [
          "agent",
          "--local",
          "--agent",
          agentId,
          "--session-id",
          sessionId,
          "--thinking",
          "minimal",
          "--timeout",
          "90",
          "--message",
          buildReportMessage(ctx),
        ];
      } else if (configuredArgs.length > 0 || mode === "raw") {
        commandArgs = [...configuredArgs];
        const passGoalAsArg = ctx.settings.passGoalAsArg === true;
        if (passGoalAsArg && ctx.goal.trim()) {
          const goalFlag = typeof ctx.settings.goalFlag === "string" && ctx.settings.goalFlag.trim()
            ? ctx.settings.goalFlag.trim()
            : "--goal";
          if (goalFlag === "__positional__") {
            commandArgs.push(ctx.goal.trim());
          } else {
            commandArgs.push(goalFlag, ctx.goal.trim());
          }
        }
        commandArgs = ensureAgentSessionId(commandArgs, buildSessionId(ctx));
        selectedAgentId =
          (typeof ctx.settings.agentId === "string" && ctx.settings.agentId.trim())
            ? ctx.settings.agentId.trim()
            : extractAgentIdFromArgs(commandArgs);
      } else {
        const configuredAgent = typeof ctx.settings.agentId === "string" && ctx.settings.agentId.trim()
          ? ctx.settings.agentId.trim()
          : null;
        const agentId = configuredAgent ?? detectDefaultAgent(profile) ?? "main";
        selectedAgentId = agentId;
        const sessionId = buildSessionId(ctx);
        const timeoutSeconds = typeof ctx.settings.timeoutSeconds === "number" && Number.isFinite(ctx.settings.timeoutSeconds)
          ? Math.max(1, Math.floor(ctx.settings.timeoutSeconds))
          : 240;
        commandArgs = [
          "agent",
          "--local",
          "--json",
          "--agent",
          agentId,
          "--session-id",
          sessionId,
          "--thinking",
          typeof ctx.settings.thinking === "string" ? ctx.settings.thinking : "minimal",
          "--timeout",
          String(timeoutSeconds),
          "--message",
          buildAgentMessage(ctx),
        ];
      }

      if (isolatedStateDir && statePrep.isolated) {
        try {
          applyWorkspaceOverrideToState({
            stateDir: isolatedStateDir,
            workspacePath: ctx.workspacePath,
            agentId: selectedAgentId,
          });
        } catch {
          // keep running with copied state if override fails
        }
      }

      return {
        command,
        args: [...rootArgs, ...commandArgs],
        cwd: ctx.workspacePath,
        env: isolatedStateDir
          ? {
              OPENCLAW_STATE_DIR: isolatedStateDir,
            }
          : undefined,
      };
    },
  },
};
