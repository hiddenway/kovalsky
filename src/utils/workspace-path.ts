import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function stripWrappingQuotes(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (
    (first === "\"" && last === "\"")
    || (first === "'" && last === "'")
    || (first === "`" && last === "`")
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function normalizeWorkspaceInput(rawPath: string | undefined): string {
  let input = stripWrappingQuotes((rawPath ?? "").trim());
  if (!input) {
    return "";
  }

  if (input.startsWith("file://")) {
    try {
      input = fileURLToPath(new URL(input));
    } catch {
      // Keep original input if URL parsing fails.
    }
  }

  if (/%[0-9A-Fa-f]{2}/.test(input)) {
    try {
      input = decodeURIComponent(input);
    } catch {
      // Keep original input if decoding fails.
    }
  }

  return input.trim();
}

function collectWorkspaceCandidates(rawPath: string | undefined): string[] {
  const input = normalizeWorkspaceInput(rawPath);
  if (!input) {
    return [];
  }
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string): void => {
    const normalized = path.resolve(candidate);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      candidates.push(normalized);
    }
  };

  if (input.startsWith("~/") || input === "~") {
    const suffix = input === "~" ? "" : input.slice(2);
    push(path.join(os.homedir(), suffix));
    push(path.resolve(input));
    return candidates;
  }

  if (path.isAbsolute(input)) {
    push(input);
    push(path.join(os.homedir(), input.replace(/^\/+/, "")));
  } else {
    push(path.resolve(process.cwd(), input));
    push(path.join(os.homedir(), input));
  }
  return candidates;
}

export function resolveWorkspacePath(rawPath: string | undefined): string | null {
  const candidates = collectWorkspaceCandidates(rawPath);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function resolveOrCreateWorkspacePath(rawPath: string | undefined): string | null {
  const existing = resolveWorkspacePath(rawPath);
  if (existing) {
    return existing;
  }
  const candidates = collectWorkspaceCandidates(rawPath);
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return null;
}
