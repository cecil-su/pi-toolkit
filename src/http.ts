import { VERSION } from "@earendil-works/pi-coding-agent";
import type { SupportedProvider } from "./data.ts";

type Endpoint = SupportedProvider | "codex-models";
export const ENDPOINTS: Record<Endpoint, string> = {
  "openai-codex": "https://chatgpt.com/backend-api/wham/usage",
  deepseek: "https://api.deepseek.com/user/balance",
  "codex-models": `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(VERSION)}`,
};

export class ReadFailure extends Error {
  constructor(readonly kind: "http" | "network" | "timeout" | "cancelled" | "invalid" | "oversize", readonly status?: number, readonly retryAt?: number) {
    super("Usage unavailable");
  }
}
export function retryAfter(value: string | null, now: number): number | undefined {
  if (!value || value.length > 128) return undefined;
  const text = value.trim();
  const at = /^\d+$/.test(text) ? now + Number(text) * 1000 : Date.parse(text);
  return Number.isFinite(at) && at > now && at <= 8_640_000_000_000_000 ? at : undefined;
}

/** Per-account endpoint deadlines survive model changes, force checks and cancellation. */
export class ReadThrottle {
  private readonly states = new Map<string, { failures: number; until: number }>();
  constructor(private readonly baseMs = 10_000, private readonly maxMs = 300_000) {}
  allowed(key: string, now: number): boolean { return now >= (this.states.get(key)?.until ?? -Infinity); }
  success(key: string): void { this.states.delete(key); }
  failure(key: string, error: unknown, now: number): void {
    if (error instanceof ReadFailure && error.kind === "cancelled") return;
    const failures = Math.min(30, (this.states.get(key)?.failures ?? 0) + 1);
    const until = Math.max(this.states.get(key)?.until ?? 0, now + Math.min(this.maxMs, this.baseMs * 2 ** (failures - 1)),
      error instanceof ReadFailure ? error.retryAt ?? 0 : 0);
    this.states.set(key, { failures, until });
  }
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new Error("Operation cancelled"));
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** Fixed GET routes; only safe failure metadata escapes, never payload or header values. */
export async function requestJson(
  provider: Endpoint, headers: Record<string, string>, parent: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch, timeoutMs = 8000, maxBytes = 65_536, now: () => number = Date.now,
): Promise<unknown> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  parent.addEventListener("abort", cancel, { once: true });
  if (parent.aborted) cancel();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  timer.unref?.();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let body: ReadableStream<Uint8Array> | null | undefined;
  try {
    controller.signal.throwIfAborted();
    const response = await abortable(fetcher(ENDPOINTS[provider], {
      method: "GET", headers: { Accept: "application/json", ...headers },
      redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
    }).then((response) => {
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new ReadFailure("cancelled");
      }
      return response;
    }), controller.signal);
    body = response.body;
    if (response.redirected || (response.url && response.url !== ENDPOINTS[provider])) throw new ReadFailure("invalid");
    if (!response.ok) throw new ReadFailure("http", response.status, retryAfter(response.headers.get("retry-after"), now()));
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new ReadFailure("oversize");
    if (!body) throw new ReadFailure("invalid");
    reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await abortable(reader.read(), controller.signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ReadFailure("oversize");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new ReadFailure("invalid"); }
  } catch (error) {
    if (parent.aborted) throw new ReadFailure("cancelled");
    if (timedOut) throw new ReadFailure("timeout");
    if (error instanceof ReadFailure) throw error;
    throw new ReadFailure("network");
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", cancel);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
    else if (body) void body.cancel().catch(() => {});
  }
}
