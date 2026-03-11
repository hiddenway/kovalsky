import type { AgentPlugin } from "../types";
import type { StepExecutionContext } from "../../types";

const DEFAULT_CODEX_MODEL = "gpt-5.2-codex";

function asStringArray(input: unknown): string[] {
  return Array.isArray(input) ? input.map(String) : [];
}

function asBoolean(input: unknown, fallback: boolean): boolean {
  return typeof input === "boolean" ? input : fallback;
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

function asString(input: unknown): string {
  return typeof input === "string" ? input : "";
}

function resolveModelOverride(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const normalized = input.trim();
  return normalized.length > 0 ? normalized : null;
}

function hasModelOption(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--model" || arg === "-m" || arg.startsWith("--model=")) {
      return true;
    }
  }
  return false;
}

function injectExecModelOption(args: string[], model: string | null): string[] {
  if (!model || hasModelOption(args)) {
    return args;
  }
  if (args[0] !== "exec") {
    return args;
  }
  return [...args, "--model", model];
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

function requiresWorkspaceRelativeProjectPath(ctx: StepExecutionContext): boolean {
  const combined = [
    ctx.goal,
    ctx.plannedNode.goalAddendum ?? "",
    ctx.plannedNode.handoffContext ?? "",
  ].join("\n");
  return /(^|[\s"'`])\/projects?(?=[/\s"'`]|$)/i.test(combined);
}

function buildCodexGoal(ctx: StepExecutionContext): string {
  const parts: string[] = [];
  if (ctx.goal.trim()) {
    parts.push(ctx.goal.trim());
  }
  if (ctx.plannedNode.goalAddendum?.trim()) {
    parts.push(`Planner addendum:\n${ctx.plannedNode.goalAddendum.trim()}`);
  }
  if (ctx.plannedNode.handoffContext?.trim()) {
    parts.push(`Planner handoff context:\n${ctx.plannedNode.handoffContext.trim()}`);
  }

  const handoffBlocks: string[] = [];
  const launchHints: string[] = [];
  for (const handoff of ctx.resolvedInputs.handoffs) {
    const summary = handoff.packet?.summary?.trim();
    const context = handoff.packet?.context?.trim();
    const targeted = (handoff.packet?.handoffTo ?? []).filter((item) => item.nodeId === ctx.nodeId);
    const targetedContext = targeted.map((item) => item.context.trim()).filter(Boolean);
    const targetedHints = targeted.flatMap((item) => item.launchHints);
    launchHints.push(...(handoff.packet?.launchHints ?? []), ...targetedHints);
    const chunks = [summary, context, ...targetedContext].filter(Boolean);
    if (chunks.length > 0) {
      handoffBlocks.push(`From ${handoff.fromNodeId}: ${chunks.join(" | ")}`);
    }
  }

  if (handoffBlocks.length > 0) {
    parts.push(`Upstream handoff:\n${handoffBlocks.join("\n")}`);
  }
  const fullHandoffDump = buildFullHandoffDump(ctx);
  if (fullHandoffDump) {
    parts.push(`Full upstream handoff payloads (passthrough mode):\n${fullHandoffDump}`);
  }

  const hintLines = uniqueStrings([...launchHints, ...ctx.plannedNode.handoffTo.flatMap((item) => item.launchHints)]);
  if (hintLines.length > 0) {
    parts.push(`Launch hints:\n${hintLines.map((line) => `- ${line}`).join("\n")}`);
  }

  if (requiresWorkspaceRelativeProjectPath(ctx)) {
    parts.push("Path policy: never create or use root-level /project or /projects.");
    parts.push("When task text references /project or /projects, interpret it as ./project inside current workspace.");
  }

  parts.push(
    "Self-sufficient execution rule: if this step needs app/test servers or commands, start them in this step and pass runnable instructions in handoff; do not rely on previous step runtime.",
  );
  return parts.join("\n\n");
}

function buildCodexReportGoal(ctx: StepExecutionContext): string {
  const reportKind = ctx.reportContext?.reportKind ?? "chat_followup";
  const customTemplate = asString(ctx.settings.reportPromptTemplate).trim();
  if (customTemplate) {
    return customTemplate
      .replaceAll("{{goal}}", ctx.goal || "(empty)")
      .replaceAll("{{reportKind}}", reportKind)
      .replaceAll("{{followupPrompt}}", ctx.reportContext?.followupPrompt?.trim() || "")
      .replaceAll("{{stepStatus}}", ctx.reportContext?.stepStatus || "")
      .replaceAll("{{stepError}}", ctx.reportContext?.stepError || "")
      .replaceAll("{{artifacts}}", ctx.reportContext?.artifactTitles?.join(", ") || "")
      .replaceAll("{{logTail}}", ctx.reportContext?.logTail?.join("\n") || "")
      .replaceAll("{{chatHistory}}", formatChatHistory(ctx));
  }

  const lines: string[] = [];
  lines.push("You are a helpful assistant in node chat.");
  lines.push("No tool calls, no commands, no file edits. Reply with plain text only.");
  lines.push("Do not output code blocks, snippets, diffs, HTML/CSS/JS, or shell commands.");
  if (reportKind === "post_step") {
    lines.push("You are writing a post-execution report. The step has already finished.");
    lines.push("Write only completed outcomes in past tense.");
    lines.push("Do not write present/future action phrases like 'doing', 'will do', 'now I will'.");
    lines.push("Start with final outcome and verification result.");
  } else {
    lines.push("Explain in natural language and keep focus on what to do next.");
  }
  lines.push(`Original goal: ${ctx.goal || "(empty)"}`);
  const chatHistory = formatChatHistory(ctx);
  if (chatHistory) {
    lines.push(`Full chat history:\n${chatHistory}`);
  }
  if (ctx.reportContext?.followupPrompt?.trim()) {
    lines.push(`Follow-up user request: ${ctx.reportContext.followupPrompt.trim()}`);
    lines.push("Use the full chat history and existing run context when answering.");
    lines.push("Reply in the same language as the follow-up user request.");
    lines.push("Do not repeat or quote previous answers verbatim unless the user explicitly asks.");
    lines.push("If user asks to perform actions now, do not claim inability to execute.");
    lines.push("State brief intent and let decision line control rerun execution.");
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
  lines.push("Answer directly and naturally like an assistant, not like a rigid report template.");
  if (reportKind === "chat_followup") {
    lines.push("If data is insufficient, ask one concise clarifying question.");
    lines.push("At the very end add one strict machine-readable line:");
    lines.push("KOVALSKY_DECISION: rerun or KOVALSKY_DECISION: no_rerun");
    lines.push("Use rerun only when the user clearly asks to perform edits/actions now.");
  } else {
    lines.push("Do not add machine-readable decision lines.");
  }
  return lines.join("\n");
}

export const codexPlugin: AgentPlugin = {
  manifest: {
    id: "codex-cli",
    version: "1.0.0",
    title: "Codex CLI",
    runner: "cli",
    inputs: [],
    outputs: [],
    configSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        model: { type: "string" },
        passGoalAsArg: { type: "boolean" },
        reportPromptTemplate: { type: "string" },
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
      const command = typeof ctx.settings.command === "string" ? ctx.settings.command : "codex";
      const configuredArgs = asStringArray(ctx.settings.args);
      const dangerous = asBoolean(ctx.settings.dangerouslyBypassSandbox, true);
      let args = configuredArgs.length > 0
        ? configuredArgs
        : [
            "exec",
            "--skip-git-repo-check",
            dangerous ? "--dangerously-bypass-approvals-and-sandbox" : "--full-auto",
          ];
      args = injectExecModelOption(args, resolveModelOverride(ctx.settings.model) ?? DEFAULT_CODEX_MODEL);
      const computedGoal = (ctx.reportMode ? buildCodexReportGoal(ctx) : buildCodexGoal(ctx)).trim();
      if (asBoolean(ctx.settings.passGoalAsArg, true) && computedGoal) {
        args.push(computedGoal);
      }

      return {
        command,
        args,
        cwd: ctx.workspacePath,
      };
    },
  },
};
