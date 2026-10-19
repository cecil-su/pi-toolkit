import { abortable, ReadFailure, ReadThrottle, retryAfter } from "./http.ts";

export type DeepSeekEndpoint = "search" | "fetch";
export const DEEPSEEK_ENDPOINTS = {
  search: "https://api.deepseek.com/v1/tools/search",
  fetch: "https://api.deepseek.com/v1/tools/fetch",
} as const;

export class PostBlocked extends Error {
  constructor(readonly kind: "busy" | "throttled") { super("DeepSeek endpoint temporarily unavailable"); }
}

/** Instance-wide endpoint gates, deliberately NOT keyed by credentials. Never queues or retries a POST. */
export class DeepSeekPostGate {
  private readonly busy = new Set<DeepSeekEndpoint>();
  private readonly next = new Map<DeepSeekEndpoint, number>();
  private readonly backoff = new ReadThrottle(1000);
  constructor(private readonly now: () => number = Date.now) {}

  async run<T>(endpoint: DeepSeekEndpoint, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new ReadFailure("cancelled");
    if (this.busy.has(endpoint)) throw new PostBlocked("busy");
    const now = this.now();
    if (now < (this.next.get(endpoint) ?? 0) || !this.backoff.allowed(endpoint, now)) throw new PostBlocked("throttled");
    this.busy.add(endpoint);
    this.next.set(endpoint, now + 250); // At most four starts/second per endpoint in this instance.
    try {
      const result = await operation();
      this.backoff.success(endpoint);
      return result;
    } catch (error) {
      if (error instanceof ReadFailure) this.backoff.failure(endpoint, error, this.now());
      throw error;
    } finally {
      // Auth/HTTP can take longer than the start interval; still leave space after completion.
      this.next.set(endpoint, Math.max(this.next.get(endpoint) ?? 0, this.now() + 250));
      this.busy.delete(endpoint);
    }
  }
}

/** Dedicated, fixed POST routes. No arbitrary target URL, redirects, retries or error-body exposure. */
export async function postDeepSeekJson(
  endpoint: DeepSeekEndpoint, authorization: string, payload: { query: string; count: number } | { url: string }, parent: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch, timeoutMs = 30_000, maxBytes = 1_048_576, now: () => number = Date.now,
): Promise<unknown> {
  if (endpoint !== "search" && endpoint !== "fetch") throw new ReadFailure("invalid");
  const target = DEEPSEEK_ENDPOINTS[endpoint];
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
    const response = await abortable(fetcher(target, {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify(payload), redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
    }).then((response) => {
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new ReadFailure("cancelled");
      }
      return response;
    }), controller.signal);
    body = response.body;
    if (response.redirected || (response.url && response.url !== target)) throw new ReadFailure("invalid");
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
