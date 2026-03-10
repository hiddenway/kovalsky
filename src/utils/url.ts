function hasHttpProtocol(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

const LEADING_WRAPPERS = /^[`"'([{<\s]+/;
const TRAILING_WRAPPERS = /[`"'.,!?;:)\]}>]+$/;

export function normalizeUrlCandidate(input: string): string | null {
  let raw = input.trim();
  if (!raw) {
    return null;
  }

  if (!hasHttpProtocol(raw)) {
    const matched = raw.match(/https?:\/\/[^\s<>"']+/i)?.[0];
    if (!matched) {
      return null;
    }
    raw = matched;
  }

  let cleaned = raw;
  let prev = "";
  while (cleaned && cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned.replace(LEADING_WRAPPERS, "").replace(TRAILING_WRAPPERS, "");
  }

  if (!cleaned || !hasHttpProtocol(cleaned)) {
    return null;
  }

  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function extractUrlsFromText(input: string): string[] {
  const rawMatches = input.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawMatches) {
    const normalized = normalizeUrlCandidate(raw);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}
