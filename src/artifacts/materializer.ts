import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { HandoffPacket, ProducedArtifact, StepExecutionContext } from "../types";
import { extractUrlsFromText, normalizeUrlCandidate } from "../utils/url";

function hasGitRepo(workspacePath: string): boolean {
  try {
    execFileSync("git", ["-C", workspacePath, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function readStepLogLines(stepLogPath: string): string[] {
  if (!fs.existsSync(stepLogPath)) {
    return [];
  }
  return fs.readFileSync(stepLogPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[(stdout|stderr)\]\s?/, "").trim())
    .filter(Boolean);
}

function extractPatchFromStepLog(stepLogPath: string): string | null {
  const lines = readStepLogLines(stepLogPath);
  const start = lines.findIndex((line) => line.startsWith("diff --git "));
  if (start === -1) {
    return null;
  }
  const patch = lines.slice(start).join("\n").trim();
  if (!patch.startsWith("diff --git ")) {
    return null;
  }
  return `${patch}\n`;
}

function buildPatch(ctx: StepExecutionContext): { patchPath: string; changedFiles: string[]; hasChanges: boolean } {
  let diff = "";
  let changedFiles: string[] = [];

  try {
    if (!hasGitRepo(ctx.workspacePath)) {
      throw new Error("no git");
    }

    diff = execFileSync("git", ["-C", ctx.workspacePath, "diff", "--no-color"], {
      encoding: "utf8",
    });
    const status = execFileSync("git", ["-C", ctx.workspacePath, "status", "--porcelain"], {
      encoding: "utf8",
    });
    changedFiles = status
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3));

    if (!diff.trim()) {
      const fromLog = extractPatchFromStepLog(ctx.stepLogPath);
      if (fromLog) {
        diff = fromLog;
      }
    }
  } catch {
    const fromLog = extractPatchFromStepLog(ctx.stepLogPath);
    diff = fromLog ?? "";
  }

  const patchPath = path.join(ctx.stepDir, "code.patch");
  fs.writeFileSync(patchPath, diff, "utf8");
  return {
    patchPath,
    changedFiles,
    hasChanges: !!diff.trim() || changedFiles.length > 0,
  };
}

function collectResolvedUrls(ctx: StepExecutionContext): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined): void => {
    if (!value) {
      return;
    }
    const normalized = normalizeUrlCandidate(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    urls.push(normalized);
  };

  for (const artifacts of Object.values(ctx.resolvedInputs.inputsByType)) {
    for (const artifact of artifacts) {
      if (artifact.meta_json) {
        try {
          const parsed = JSON.parse(artifact.meta_json) as { url?: unknown; urls?: unknown };
          if (typeof parsed.url === "string") {
            push(parsed.url);
          }
          if (Array.isArray(parsed.urls)) {
            for (const item of parsed.urls) {
              if (typeof item === "string") {
                push(item);
              }
            }
          }
        } catch {
          // ignore malformed metadata
        }
      }

      if (/^https?:\/\//i.test(artifact.path.trim())) {
        push(artifact.path.trim());
      } else if (fs.existsSync(artifact.path)) {
        const raw = fs.readFileSync(artifact.path, "utf8");
        for (const url of extractUrlsFromText(raw)) {
          push(url);
        }
      }
    }
  }

  for (const handoff of ctx.resolvedInputs.handoffs) {
    for (const url of handoff.packet?.urls ?? []) {
      push(url);
    }
  }

  const localCandidates = ["kovalsky.url"];
  for (const rel of localCandidates) {
    const full = path.join(ctx.workspacePath, rel);
    if (!fs.existsSync(full)) {
      continue;
    }
    const raw = fs.readFileSync(full, "utf8");
    for (const url of extractUrlsFromText(raw)) {
      push(url);
    }
  }

  for (const url of extractUrlsFromText(readStepLogLines(ctx.stepLogPath).join("\n"))) {
    push(url);
  }

  return urls.sort((left, right) => scoreHandoffUrl(right) - scoreHandoffUrl(left) || left.localeCompare(right));
}

function scoreHandoffUrl(input: string): number {
  const normalized = normalizeUrlCandidate(input);
  if (!normalized) {
    return -1000;
  }

  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.trim().toLowerCase();
    const pathname = parsed.pathname.trim().toLowerCase();
    const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    const assetLike = isLikelyAssetUrl(parsed);

    let score = 0;
    if (isLocal) {
      score += 120;
    }
    if (!assetLike) {
      score += 40;
    } else {
      score -= 90;
    }
    if (/(^\/$|index\.html$|login|signin|auth|dashboard)/i.test(pathname)) {
      score += 20;
    }
    if (/\/api(\/|$)/i.test(pathname)) {
      score -= 10;
    }

    return score;
  } catch {
    return -1000;
  }
}

function isLikelyAssetUrl(parsed: URL): boolean {
  const hostname = parsed.hostname.trim().toLowerCase();
  const pathname = parsed.pathname.trim().toLowerCase();

  if (hostname === "fonts.googleapis.com" || hostname === "fonts.gstatic.com" || hostname.endsWith(".gstatic.com")) {
    return true;
  }

  if (hostname.includes("googleapis.com") && pathname.includes("/css2")) {
    return true;
  }

  return /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|eot|webp|avif)$/i.test(pathname);
}

function summarizeExecution(ctx: StepExecutionContext, exitCode: number): string {
  const lines = readStepLogLines(ctx.stepLogPath);
  if (lines.length === 0) {
    return exitCode === 0 ? "Step finished successfully." : `Step failed with exit code ${exitCode}.`;
  }

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (/thinking|\*\*/i.test(line) || line.startsWith("diff --git ")) {
      continue;
    }
    if (line.length > 220) {
      return `${line.slice(0, 217)}...`;
    }
    return line;
  }

  return exitCode === 0 ? "Step finished successfully." : `Step failed with exit code ${exitCode}.`;
}

function collectLaunchHints(ctx: StepExecutionContext): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const next = value.trim();
    if (!next || seen.has(next)) {
      return;
    }
    seen.add(next);
    out.push(next);
  };

  for (const target of ctx.plannedNode.handoffTo) {
    for (const hint of target.launchHints) {
      push(hint);
    }
  }

  for (const handoff of ctx.resolvedInputs.handoffs) {
    for (const hint of handoff.packet?.launchHints ?? []) {
      push(hint);
    }
  }

  const packageJsonPath = path.join(ctx.workspacePath, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
      const scripts = parsed.scripts ?? {};
      const candidate = ["dev", "start", "test", "build"];
      for (const name of candidate) {
        if (typeof scripts[name] === "string" && scripts[name].trim()) {
          push(`pnpm run ${name}`);
        }
      }
    } catch {
      // ignore malformed package.json
    }
  }

  return out;
}

function buildHandoffContext(ctx: StepExecutionContext): string {
  const sections: string[] = [];
  if (ctx.plannedNode.handoffContext?.trim()) {
    sections.push(ctx.plannedNode.handoffContext.trim());
  }
  if (ctx.plannedNode.goalAddendum?.trim()) {
    sections.push(ctx.plannedNode.goalAddendum.trim());
  }

  const upstream = ctx.resolvedInputs.handoffs
    .map((item) => item.packet?.summary?.trim())
    .filter((item): item is string => !!item)
    .slice(-3);
  if (upstream.length > 0) {
    sections.push(`Upstream context: ${upstream.join(" | ")}`);
  }

  if (sections.length === 0) {
    return "Carry forward only context that helps downstream nodes execute independently.";
  }
  return sections.join("\n");
}

export function materializePlannedArtifacts(ctx: StepExecutionContext, exitCode: number): ProducedArtifact[] {
  const artifacts: ProducedArtifact[] = [];
  const push = (artifact: ProducedArtifact): void => {
    artifacts.push(artifact);
  };

  push({
    type: "LogBundle",
    title: "Step Logs",
    filePath: ctx.stepLogPath,
    mime: "text/plain",
  });

  const patch = buildPatch(ctx);
  if (patch.hasChanges) {
    push({
      type: "CodePatch",
      title: "Workspace Patch",
      filePath: patch.patchPath,
      mime: "text/x-diff",
      meta: {
        changedFiles: patch.changedFiles,
      },
    });
  }

  const urls = collectResolvedUrls(ctx);
  if (urls.length > 0) {
    const urlPath = path.join(ctx.stepDir, "resolved-url.txt");
    fs.writeFileSync(urlPath, `${urls[0]}\n`, "utf8");
    push({
      type: "Url",
      title: "Resolved URL",
      filePath: urlPath,
      mime: "text/uri-list",
      meta: {
        urls,
      },
    });
  }

  const summary = summarizeExecution(ctx, exitCode);

  const handoffPacket: HandoffPacket = {
    schemaVersion: 1,
    runId: ctx.runId,
    stepRunId: ctx.stepRunId,
    fromNodeId: ctx.nodeId,
    fromAgentId: ctx.plannedNode.agentId,
    goal: ctx.goal,
    summary,
    context: buildHandoffContext(ctx),
    changedFiles: patch.changedFiles,
    urls,
    launchHints: collectLaunchHints(ctx),
    handoffTo: ctx.plannedNode.handoffTo,
    generatedAt: new Date().toISOString(),
  };

  const handoffPath = path.join(ctx.stepDir, "handoff.json");
  fs.writeFileSync(handoffPath, JSON.stringify(handoffPacket, null, 2), "utf8");
  push({
    type: "HandoffPacket",
    title: "Node Handoff",
    filePath: handoffPath,
    mime: "application/json",
    meta: {
      fromNodeId: ctx.nodeId,
      handoffTo: ctx.plannedNode.handoffTo.map((item) => item.nodeId),
    },
  });

  return artifacts;
}
