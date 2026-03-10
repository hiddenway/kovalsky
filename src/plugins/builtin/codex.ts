import type { AgentPlugin } from "../types";
import type { StepExecutionContext } from "../../types";

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

  parts.push(
    "Self-sufficient execution rule: if this step needs app/test servers or commands, start them in this step and pass runnable instructions in handoff; do not rely on previous step runtime.",
  );
  return parts.join("\n\n");
}

function buildCodexReportGoal(ctx: StepExecutionContext): string {
  const customTemplate = asString(ctx.settings.reportPromptTemplate).trim();
  if (customTemplate) {
    return customTemplate
      .replaceAll("{{goal}}", ctx.goal || "(empty)")
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
  lines.push("Explain in natural language and keep focus on what to do next.");
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
  lines.push("If data is insufficient, ask one concise clarifying question.");
  lines.push("At the very end add one strict machine-readable line:");
  lines.push("KOVALSKY_DECISION: rerun or KOVALSKY_DECISION: no_rerun");
  lines.push("Use rerun only when the user clearly asks to perform edits/actions now.");
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
      const args = configuredArgs.length > 0
        ? configuredArgs
        : [
            "exec",
            "--skip-git-repo-check",
            dangerous ? "--dangerously-bypass-approvals-and-sandbox" : "--full-auto",
          ];
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
