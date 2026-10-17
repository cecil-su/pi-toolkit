import { createHmac, randomBytes } from "node:crypto";
import type { Api, Model, ModelAuth } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SupportedProvider } from "./data.ts";
import { abortable } from "./http.ts";

export interface Identity {
  provider: SupportedProvider;
  modelId: string;
  scope: string;
  accountScope?: string;
  headers: Record<string, string>;
  account?: string;
  expiresAt?: number;
}
export type AuthRegistry = Pick<ModelRegistry, "getApiKeyAndHeaders" | "isUsingOAuth">;
const salt = randomBytes(32);
export class UntrustedAuthTargetError extends Error {
  constructor() { super("Untrusted authentication target"); }
}
export function supported(provider?: string): provider is SupportedProvider { return provider === "openai-codex" || provider === "deepseek"; }
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
const digest = (value: unknown) => createHmac("sha256", salt).update(JSON.stringify(value)).digest("hex");

/** Reads only the bearer/target already resolved for this particular request. */
export function requestIdentity(model: Model<Api>, auth: ModelAuth, now = Date.now()): Identity {
  const provider = model.provider;
  if (!supported(provider) || !officialBase(provider, model.baseUrl) ||
      (auth.baseUrl !== undefined && !officialBase(provider, auth.baseUrl))) throw new UntrustedAuthTargetError();
  const target = auth.baseUrl ?? model.baseUrl;
  const token = auth.apiKey;
  if (!token || token.length > 24_000 || !/^[\x21-\x7e]+$/.test(token)) throw new Error("Authentication unavailable");
  const configured = { ...model.headers, ...auth.headers };
  for (const key of Object.keys(configured)) {
    if (/^(authorization|proxy-authorization|x-api-key|api-key)$/i.test(key)) throw new UntrustedAuthTargetError();
  }
  let account: string | undefined, subject: string | undefined, expiresAt: number | undefined;
  if (provider === "openai-codex") {
    const parts = token.split(".");
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw new Error("OAuth unavailable");
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    account = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    subject = claims?.sub;
    if (!safeIdentity(account) || !safeIdentity(subject) || typeof claims.exp !== "number" ||
        !Number.isFinite(claims.exp) || claims.exp * 1000 <= now) throw new Error("OAuth unavailable");
    expiresAt = claims.exp * 1000;
    for (const [key, value] of Object.entries(configured)) {
      if (key.toLowerCase() === "chatgpt-account-id" && value !== account) throw new Error("Account mismatch");
    }
  }
  return { provider, modelId: model.id, account, expiresAt,
    scope: digest([provider, model.id, model.api, target, token, account]),
    accountScope: digest([provider, new URL(target).origin, account ?? token, subject]),
    headers: { Authorization: `Bearer ${token}`, ...(account ? { "chatgpt-account-id": account } : {}) },
  };
}

/** Only current runtime auth is resolved for interactive discovery, never for a bound request. */
export async function resolveIdentity(model: Model<Api>, registry: AuthRegistry, signal: AbortSignal, now = Date.now(), timeoutMs = 8000): Promise<Identity> {
  if (!supported(model.provider) || !officialBase(model.provider, model.baseUrl)) throw new UntrustedAuthTargetError();
  const local = new AbortController();
  const cancel = () => local.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(cancel, timeoutMs); timer.unref?.();
  try {
    local.signal.throwIfAborted();
    const auth = await abortable(registry.getApiKeyAndHeaders(model), local.signal);
    if (!auth.ok || (model.provider === "openai-codex" && !registry.isUsingOAuth(model))) throw new Error("Auth unavailable");
    return requestIdentity(model, auth, now);
  } catch (error) {
    if (error instanceof UntrustedAuthTargetError) throw error;
    throw new Error("Authentication unavailable");
  } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); local.abort(); }
}
