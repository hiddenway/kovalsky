import fs from "node:fs";
import path from "node:path";
import { DatabaseService } from "../db";
import { ensureDir } from "../utils/fs";
import type { SecretRecord } from "../types";

const SUPPORTED_PROVIDERS = new Set(["openai", "codex", "openclaw"]);

function extractTokenFromCallbackUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  const fromParams = (params: URLSearchParams): string => {
    return params.get("access_token")
      || params.get("api_key")
      || params.get("token")
      || params.get("id_token")
      || params.get("code")
      || "";
  };

  const maybeUrl = /^https?:\/\//i.test(trimmed) || trimmed.startsWith("localhost:");
  if (!maybeUrl) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed.startsWith("http") ? trimmed : `http://${trimmed}`);
    const fromQuery = fromParams(parsed.searchParams).trim();
    if (fromQuery) {
      return fromQuery;
    }

    const fromHash = fromParams(new URLSearchParams(parsed.hash.replace(/^#/, ""))).trim();
    if (fromHash) {
      return fromHash;
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}

export class ProviderService {
  private readonly secretsDir: string;

  constructor(
    private readonly db: DatabaseService,
    appDataDir: string,
  ) {
    this.secretsDir = path.join(appDataDir, "credentials");
    ensureDir(this.secretsDir);
  }

  private buildSecretFilePath(provider: string, credentialId: string): string {
    return path.join(this.secretsDir, `${provider}-${credentialId}.token`);
  }

  private resolveSecretFilePath(secret: SecretRecord): string {
    const ref = secret.keychain_ref.trim();
    if (ref) {
      return ref;
    }
    return this.buildSecretFilePath(secret.provider, secret.id);
  }

  async connectProvider(
    provider: string,
    apiKey: string,
    label: string,
    authType: "api_key" | "oauth" = "api_key",
  ): Promise<{ credentialId: string }> {
    const normalizedProvider = provider.trim().toLowerCase();
    if (!SUPPORTED_PROVIDERS.has(normalizedProvider)) {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    const normalizedSecret = authType === "oauth" ? extractTokenFromCallbackUrl(apiKey) : apiKey.trim();
    if (!normalizedSecret) {
      throw new Error("apiKey is required");
    }

    const defaultLabel = normalizedProvider === "openai"
      ? "OpenAI"
      : normalizedProvider === "codex"
        ? "Codex"
        : "OpenClaw";
    const methodSuffix = authType === "oauth" ? " OAuth" : " API key";

    const secret = this.db.createSecret(normalizedProvider, label || `${defaultLabel}${methodSuffix}`, "");
    const secretFilePath = this.buildSecretFilePath(normalizedProvider, secret.id);
    try {
      fs.writeFileSync(secretFilePath, normalizedSecret, { mode: 0o600 });
      this.db.updateSecretKeychainRef(secret.id, secretFilePath);
    } catch (error) {
      this.db.deleteSecret(secret.id);
      throw error;
    }

    return { credentialId: secret.id };
  }

  async connectOpenAI(apiKey: string, label: string): Promise<{ credentialId: string }> {
    return this.connectProvider("openai", apiKey, label, "api_key");
  }

  listProviders(): SecretRecord[] {
    return this.db.listSecrets();
  }

  getLatestCredential(provider?: string): SecretRecord | null {
    const all = this.db.listSecrets();
    if (!provider) {
      return all[0] ?? null;
    }
    return all.find((item) => item.provider === provider) ?? null;
  }

  async deleteCredential(credentialId: string): Promise<void> {
    const secret = this.db.getSecret(credentialId);
    if (!secret) {
      return;
    }

    const secretFilePath = this.resolveSecretFilePath(secret);
    if (fs.existsSync(secretFilePath)) {
      fs.unlinkSync(secretFilePath);
    }
    this.db.deleteSecret(credentialId);
  }

  async getCredentialSecret(credentialId: string): Promise<string | null> {
    const secret = this.db.getSecret(credentialId);
    if (!secret) {
      return null;
    }

    const secretFilePath = this.resolveSecretFilePath(secret);
    if (!fs.existsSync(secretFilePath)) {
      return null;
    }
    return fs.readFileSync(secretFilePath, "utf8").trim() || null;
  }

  async getLatestCredentialSecret(provider: string): Promise<string | null> {
    const credential = this.getLatestCredential(provider);
    if (!credential) {
      return null;
    }
    return this.getCredentialSecret(credential.id);
  }
}
