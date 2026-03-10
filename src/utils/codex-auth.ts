import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CodexAuthState {
  token: string;
  authenticated: boolean;
  expired: boolean;
  expiresAt: string | null;
  authPath: string;
}

function asObject(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

function normalizeExpiryMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
}

function decodeJwtExpiryMs(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { exp?: unknown };
    return normalizeExpiryMs(decoded.exp ?? null);
  } catch {
    return null;
  }
}

function pickToken(source: Record<string, unknown>): string {
  return (
    (typeof source.access_token === "string" && source.access_token.trim())
    || (typeof source.token === "string" && source.token.trim())
    || (typeof source.api_key === "string" && source.api_key.trim())
    || (typeof source.OPENAI_API_KEY === "string" && source.OPENAI_API_KEY.trim())
    || (typeof source.id_token === "string" && source.id_token.trim())
    || ""
  );
}

function pickExpiryMs(
  source: Record<string, unknown>,
  tokenCandidates: string[],
): number | null {
  const direct =
    normalizeExpiryMs(source.expires_at ?? null)
    ?? normalizeExpiryMs(source.expiresAt ?? null)
    ?? normalizeExpiryMs(source.expiry ?? null)
    ?? normalizeExpiryMs(source.expiration ?? null);
  if (direct) {
    return direct;
  }

  for (const token of tokenCandidates) {
    const fromJwt = decodeJwtExpiryMs(token);
    if (fromJwt) {
      return fromJwt;
    }
  }

  return null;
}

export function readCodexAuthState(env: NodeJS.ProcessEnv = process.env): CodexAuthState {
  const codexHome = (env.CODEX_HOME ?? "").trim() || path.join(os.homedir(), ".codex");
  const authPath = path.join(codexHome, "auth.json");
  if (!fs.existsSync(authPath)) {
    return {
      token: "",
      authenticated: false,
      expired: false,
      expiresAt: null,
      authPath,
    };
  }

  try {
    const parsed = asObject(JSON.parse(fs.readFileSync(authPath, "utf8")));
    if (!parsed) {
      throw new Error("Invalid auth storage");
    }

    const tokens = asObject(parsed.tokens);
    const token = (tokens ? pickToken(tokens) : "") || pickToken(parsed);
    if (!token) {
      return {
        token: "",
        authenticated: false,
        expired: false,
        expiresAt: null,
        authPath,
      };
    }

    const tokenCandidates = [
      typeof tokens?.id_token === "string" ? tokens.id_token : "",
      typeof tokens?.access_token === "string" ? tokens.access_token : "",
      token,
    ].filter(Boolean);
    const expiryMs = (tokens ? pickExpiryMs(tokens, tokenCandidates) : null) ?? pickExpiryMs(parsed, tokenCandidates);
    const expired = expiryMs ? Date.now() >= expiryMs - 15_000 : false;

    return {
      token,
      authenticated: !expired,
      expired,
      expiresAt: expiryMs ? new Date(expiryMs).toISOString() : null,
      authPath,
    };
  } catch {
    return {
      token: "",
      authenticated: false,
      expired: false,
      expiresAt: null,
      authPath,
    };
  }
}
