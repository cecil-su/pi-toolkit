import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DEEPSEEK_ENDPOINTS, DeepSeekPostGate, PostBlocked, postDeepSeekJson } from "../src/deepseek-http.ts";
import { ReadFailure } from "../src/http.ts";

const signal = () => new AbortController().signal;
const now = 1_800_000_000_000;
const safeFailure = (kind: ReadFailure["kind"], status?: number) => (error: unknown) => {
  assert.ok(error instanceof ReadFailure);
  assert.equal(error.kind, kind);
  assert.equal(error.status, status);
  assert.doesNotMatch(error.message, /SECRET|Bearer|private/);
  return true;
};

test("POST uses only two fixed routes, minimal headers/body, no credentials, redirects or retries", async (t) => {
  const timers = t.mock.method(globalThis, "setTimeout");
  for (const endpoint of ["search", "fetch"] as const) {
    const payload = endpoint === "search" ? { query: "合成😀", count: 5 } : { url: "https://example.com/page" };
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls++;
      assert.equal(url, DEEPSEEK_ENDPOINTS[endpoint]);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.cache, "no-store");
      assert.deepEqual(init?.headers, { Accept: "application/json", "Content-Type": "application/json", Authorization: "Bearer synthetic-key" });
      assert.deepEqual(JSON.parse(init?.body as string), payload);
      return new Response('{"ok":true}');
    };
    assert.deepEqual(await postDeepSeekJson(endpoint, "Bearer synthetic-key", payload, signal(), fetcher), { ok: true });
    assert.equal(calls, 1);
  }
  assert.ok(timers.mock.calls.every((call) => call.arguments[1] === 30_000), "POST defaults to 30 seconds independently of auth/GET");
  for (const endpoint of ["https://evil.example", "toString", "__proto__"]) {
    await assert.rejects(postDeepSeekJson(endpoint as "search", "Bearer synthetic", { query: "x", count: 5 }, signal(),
      async () => { assert.fail("unknown route must not fetch"); }), safeFailure("invalid"));
  }
});

test("every HTTP error exposes only status/classification; Retry-After seconds/date is parsed without replay", async () => {
  for (const status of [400, 401, 402, 403, 404, 408, 413, 429, 500, 504, 302]) {
    let calls = 0, cancelled = false;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response(new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode('SECRET private error body, Bearer synthetic-key')); },
        cancel() { cancelled = true; },
      }), { status, headers: { "retry-after": "120", Location: "https://evil.example" } });
    };
    await assert.rejects(postDeepSeekJson("search", "Bearer synthetic-key", { query: "x", count: 5 }, signal(), fetcher, 100, 128, () => now),
      (error: unknown) => { safeFailure("http", status)(error); assert.equal((error as ReadFailure).retryAt, now + 120000); return true; });
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  }
  const until = now + 600000;
  await assert.rejects(postDeepSeekJson("fetch", "Bearer synthetic-key", { url: "https://example.com" }, signal(),
    async () => new Response("SECRET", { status: 429, headers: { "retry-after": new Date(until).toUTCString() } }), 100, 128, () => now),
  (error: unknown) => { assert.ok(error instanceof ReadFailure); assert.equal(error.retryAt, until); return true; });
});

test("POST rejects redirected/foreign responses, malformed JSON/UTF8, empty and oversized bodies", async () => {
  const redirected = new Response("{}");
  Object.defineProperty(redirected, "redirected", { value: true });
  const foreign = new Response("{}");
  Object.defineProperty(foreign, "url", { value: "https://evil.example/private" });
  const responses: [Response, ReadFailure["kind"]][] = [
    [redirected, "invalid"], [foreign, "invalid"], [new Response(null), "invalid"],
    [new Response("{SECRET"), "invalid"], [new Response(new Uint8Array([0xff])), "invalid"],
    [new Response("{}", { headers: { "content-length": "invalid" } }), "oversize"],
    [new Response("{}", { headers: { "content-length": "1000" } }), "oversize"],
    [new Response("x".repeat(129)), "oversize"],
  ];
  for (const [response, kind] of responses) {
    await assert.rejects(postDeepSeekJson("search", "Bearer synthetic", { query: "x", count: 5 }, signal(), async () => response, 100, 128), safeFailure(kind));
  }
  await assert.rejects(postDeepSeekJson("search", "Bearer synthetic", { query: "x", count: 5 }, signal(),
    async () => { throw new Error("SECRET Bearer private"); }), safeFailure("network"));
  let cancelled = false, chunks = 0;
  const stream = new Response(new ReadableStream<Uint8Array>({
    pull(c) { chunks++; c.enqueue(new Uint8Array(40)); }, cancel() { cancelled = true; },
  }));
  await assert.rejects(postDeepSeekJson("fetch", "Bearer synthetic", { url: "https://example.com" }, signal(), async () => stream, 100, 64), safeFailure("oversize"));
  assert.equal(cancelled, true);
  assert.ok(chunks <= 4);
});

test("timeouts/cancellation bound non-cooperating fetch and body reads, including late-response cleanup", async () => {
  let received: AbortSignal | undefined;
  const stall: typeof fetch = async (_url, init) => { received = init?.signal ?? undefined; return new Promise(() => {}); };
  await Promise.all([
    assert.rejects(postDeepSeekJson("search", "Bearer synthetic", { query: "x", count: 5 }, signal(), stall, 5), safeFailure("timeout")), delay(20),
  ]);
  assert.equal(received?.aborted, true);
  let cancelled = false;
  const body = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await Promise.all([
    assert.rejects(postDeepSeekJson("fetch", "Bearer synthetic", { url: "https://example.com" }, signal(), async () => body, 5), safeFailure("timeout")), delay(20),
  ]);
  assert.equal(cancelled, true);
  const controller = new AbortController();
  let finish!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  const request = postDeepSeekJson("search", "Bearer synthetic", { query: "x", count: 5 }, controller.signal, async () => pending);
  controller.abort();
  await assert.rejects(request, safeFailure("cancelled"));
  let lateCancelled = false;
  finish(new Response(new ReadableStream({ cancel() { lateCancelled = true; } })));
  await delay(0);
  assert.equal(lateCancelled, true);
  await assert.rejects(postDeepSeekJson("search", "Bearer synthetic", { query: "x", count: 5 }, controller.signal,
    async () => { assert.fail("already aborted"); }), safeFailure("cancelled"));
  const bodyAbort = new AbortController();
  const bodyRequest = postDeepSeekJson("fetch", "Bearer synthetic", { url: "https://example.com" }, bodyAbort.signal,
    async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await delay(0);
  bodyAbort.abort();
  await assert.rejects(bodyRequest, safeFailure("cancelled"));
});

test("instance endpoint gate serializes calls and keeps Retry-After/backoff across failures/cancellation", async () => {
  let clock = now, calls = 0;
  const gate = new DeepSeekPostGate(() => clock);
  const run = (endpoint: "search" | "fetch", operation = async () => { calls++; return "ok"; }) => gate.run(endpoint, signal(), operation);
  let finish!: (value: string) => void;
  const pending = run("search", () => { calls++; return new Promise<string>((resolve) => { finish = resolve; }); });
  await assert.rejects(run("search"), (error: unknown) => error instanceof PostBlocked && error.kind === "busy");
  assert.equal(await run("fetch"), "ok");
  clock += 1000; // A slow operation must still leave a gap after completion, not only after entry.
  finish("ok"); await pending;
  await assert.rejects(run("search"), PostBlocked);
  clock += 250;
  assert.equal(await run("search"), "ok");
  clock += 250;
  await assert.rejects(run("search", async () => { calls++; throw new ReadFailure("http", 429, clock + 600000); }));
  const count = calls;
  clock += 599999;
  await assert.rejects(run("search"), PostBlocked);
  assert.equal(calls, count);
  clock++;
  await assert.rejects(run("search", async () => { calls++; throw new ReadFailure("http", 500); }));
  clock += 1999; await assert.rejects(run("search"), PostBlocked);
  clock++; assert.equal(await run("search"), "ok");
  clock += 250;
  await assert.rejects(run("search", async () => { throw new ReadFailure("cancelled"); }));
  clock += 250; assert.equal(await run("search"), "ok");
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(gate.run("fetch", aborted.signal, async () => { assert.fail("cancelled operation"); }));
});
