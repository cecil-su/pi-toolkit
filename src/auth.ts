import { createHmac, randomBytes } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SupportedProvider } from "./data.ts";
import { abortable } from "./http.ts";

export interface Identity {
  provider: SupportedProvider;
  modelId: string;
  scope: string; // Process-local, non-reversible credential fingerprint. Never logged/persisted.
  headers: Record<string, string>;
  account?: string;
  expiresAt?: number;
}

export type AuthRegistry = Pick<ModelRegistry, "getApiKeyAndHeaders" | "isUsingOAuth">;
const salt = randomBytes(32);

export function supported(provider?: string): provider is SupportedProvider {
  return provider === "openai-codex" || provider === "deepseek";
}

export function officialBase(provider: SupportedProvider, value: string): boolean {
  try {
    const url = new URL(value);
    const paths = provider === "openai-codex" ? ["", "/backend-api", "/backend-api/codex"] : ["", "/v1"];
    return url.origin === (provider === "openai-codex" ? "https://chatgpt.com" : "https://api.deepseek.com") &&
      !url.username && !url.password && !url.search && !url.hash && paths.includes(url.pathname.replace(/\/$/, ""));
  } catch { return false; }
}

function safeIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[\x21-\x7e]+$/.test(value);
}

/** Only current runtime auth is resolved. No credential-file or session access. */
export async function resolveIdentity(
  model: Model<Api>, registry: AuthRegistry, signal: AbortSignal, now = Date.now(), timeoutMs = 8000,
): Promise<Identity> {
  const provider = model.provider;
  if (!supported(provider) || !officialBase(provider, model.baseUrl)) throw new Error("Unsupported endpoint");
  const local = new AbortController();
  const cancel = () => local.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(cancel, timeoutMs);
  timer.unref?.();
  try {
    local.signal.throwIfAborted();
    const auth = await abortable(registry.getApiKeyAndHeaders(model), local.signal);
    if (!auth.ok || (auth.baseUrl !== undefined && !officialBase(provider, auth.baseUrl))) throw new Error("Auth unavailable");
    const token = auth.apiKey;
    if (!token || token.length > 24_000 || !/^[\x21-\x7e]+$/.test(token)) throw new Error("Auth unavailable");
    // Refuse ambiguous header-based authentication instead of forwarding the wrong API key.
    const configured = { ...model.headers, ...auth.headers };
    for (const key of Object.keys(configured)) {
      if (/^(authorization|proxy-authorization|x-api-key|api-key)$/i.test(key)) throw new Error("Ambiguous authentication");
    }
    let account: string | undefined;
    let expiresAt: number | undefined;
    if (provider === "openai-codex") {
      if (!registry.isUsingOAuth(model)) throw new Error("OAuth required");
      const parts = token.split(".");
      if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw new Error("OAuth required");
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      const claim = claims?.["https://api.openai.com/auth"];
      account = claim?.chatgpt_account_id;
      if (!safeIdentity(account) || !safeIdentity(claims.sub) || typeof claims.exp !== "number" ||
          !Number.isFinite(claims.exp) || claims.exp * 1000 <= now) throw new Error("OAuth unavailable");
      expiresAt = claims.exp * 1000;
      for (const [key, value] of Object.entries(configured)) {
        if (key.toLowerCase() === "chatgpt-account-id" && value !== account) throw new Error("Account mismatch");
      }
    }
    return {
      provider, modelId: model.id, account, expiresAt,
      scope: createHmac("sha256", salt).update(JSON.stringify([provider, model.id, model.api, model.baseUrl, token, account])).digest("hex"),
      headers: { Authorization: `Bearer ${token}`, ...(account ? { "chatgpt-account-id": account } : {}) },
    };
  } catch {
    throw new Error("Authentication unavailable");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    local.abort();
  }
}
