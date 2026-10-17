import type { SupportedProvider } from "./data.ts";

export const ENDPOINTS: Record<SupportedProvider, string> = {
  "openai-codex": "https://chatgpt.com/backend-api/wham/usage",
  deepseek: "https://api.deepseek.com/user/balance",
};

/** Also bounds mocks or runtime promises which don't cooperate with AbortSignal. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new Error("Operation cancelled"));
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** Fixed GET routes only. No response text or caught exception is surfaced to the UI/log. */
export async function requestJson(
  provider: SupportedProvider,
  headers: Record<string, string>,
  parent: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
  timeoutMs = 8000,
  maxBytes = 65_536,
): Promise<unknown> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  parent.addEventListener("abort", cancel, { once: true });
  if (parent.aborted) cancel();
  const timer = setTimeout(cancel, timeoutMs);
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
        throw new Error("Operation cancelled");
      }
      return response;
    }), controller.signal);
    body = response.body;
    // redirect:error is enforced by fetch; explicit checks cover custom fetch implementations.
    if (response.redirected || !response.ok || (response.url && response.url !== ENDPOINTS[provider])) {
      throw new Error("Usage request failed");
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error("Response too large");
    if (!body) throw new Error("Empty usage response");
    reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await abortable(reader.read(), controller.signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Response too large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Usage unavailable");
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", cancel);
    controller.abort();
    // Do not await cancellation: a hostile or broken stream may never acknowledge it.
    if (reader) void reader.cancel().catch(() => {});
    else if (body) void body.cancel().catch(() => {});
  }
}
