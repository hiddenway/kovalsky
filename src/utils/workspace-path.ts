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

export function resolveWorkspacePath(rawPath: string | undefined): string | null {
  const input = normalizeWorkspaceInput(rawPath);
  if (!input) {
    return null;
  }

  const candidates = new Set<string>();
  candidates.add(path.resolve(input));

  if (input.startsWith("~/") || input === "~") {
    const suffix = input === "~" ? "" : input.slice(2);
    candidates.add(path.join(os.homedir(), suffix));
  }

  if (!path.isAbsolute(input)) {
    candidates.add(path.resolve(process.cwd(), input));
    candidates.add(path.join(os.homedir(), input));
  } else {
    candidates.add(path.join(os.homedir(), input.replace(/^\/+/, "")));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return null;
}
