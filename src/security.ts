import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { FastifyReply, FastifyRequest } from "fastify";
import { ensureDir } from "./utils/fs";

export function ensurePairingToken(tokenFilePath: string): string {
  ensureDir(path.dirname(tokenFilePath));
  if (fs.existsSync(tokenFilePath)) {
    return fs.readFileSync(tokenFilePath, "utf8").trim();
  }

  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(tokenFilePath, token, { mode: 0o600 });
  return token;
}

export function buildAuthPreHandler(pairingToken: string) {
  return async function authPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (request.url.startsWith("/health")) {
      return;
    }

    if (request.url.startsWith("/trigger-hooks/")) {
      return;
    }

    if (request.url.startsWith("/stream")) {
      const parsed = new URL(request.url, "http://localhost");
      const queryToken = parsed.searchParams.get("token");
      if (queryToken === pairingToken) {
        return;
      }
    }

    const authHeader = request.headers.authorization;
    const expected = `Bearer ${pairingToken}`;

    if (!authHeader || authHeader !== expected) {
      reply.code(401).send({ error: "Unauthorized" });
    }
  };
}

export function isLocalhostAddress(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
