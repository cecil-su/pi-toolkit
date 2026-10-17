import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type AuthRegistry, officialBase, resolveIdentity } from "../src/auth.ts";
import { abortable, ENDPOINTS, requestJson } from "../src/http.ts";

const now = 1_800_000_000_000;
function model(provider = "openai-codex", baseUrl = "https://chatgpt.com/backend-api"): Model<Api> {
  return { provider, id: "test-model", name: "Runtime Display Name", api: "openai-codex-responses", baseUrl } as Model<Api>;
}
function token(account = "synthetic-a", subject = "synthetic-user", expires = now / 1000 + 3600): string {
  return `synthetic.${Buffer.from(JSON.stringify({ sub: subject, exp: expires,
    "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.synthetic`;
}
type RuntimeAuth = Awaited<ReturnType<AuthRegistry["getApiKeyAndHeaders"]>>;
function registry(apiKey: string, overrides: Record<string, unknown> = {}): AuthRegistry {
  return { getApiKeyAndHeaders: async () => ({ ok: true, apiKey, ...overrides } as RuntimeAuth), isUsingOAuth: () => true };
}
const signal = () => new AbortController().signal;

test("runtime auth creates isolated account/model/provider/credential scopes", async () => {
  const a = await resolveIdentity(model(), registry(token()), signal(), now);
  const repeat = await resolveIdentity(model(), registry(token()), signal(), now);
  assert.equal(a.scope, repeat.scope);
  assert.equal(a.headers.Authorization, `Bearer ${token()}`);
  assert.equal(a.headers["chatgpt-account-id"], "synthetic-a");
  assert.equal(a.expiresAt, now + 3600000);
  assert.notEqual(a.scope, (await resolveIdentity(model(), registry(token("synthetic-b")), signal(), now)).scope);
  assert.notEqual(a.scope, (await resolveIdentity({ ...model(), id: "other-model" }, registry(token()), signal(), now)).scope);
  assert.notEqual(a.scope, (await resolveIdentity(model(), registry(token("synthetic-a", "other-user")), signal(), now)).scope);
  const deepseek = await resolveIdentity(model("deepseek", "https://api.deepseek.com/v1"), registry("synthetic-key"), signal(), now);
  assert.deepEqual(deepseek.headers, { Authorization: "Bearer synthetic-key" });
  assert.equal(deepseek.account, undefined);
});

test("official model and effective auth endpoints are both mandatory", async () => {
  const urls = ["https://evil.example", "https://chatgpt.com.evil.example/backend-api", "http://chatgpt.com/backend-api",
    "https://user:pass@chatgpt.com/backend-api", "https://chatgpt.com:8443/backend-api", "https://chatgpt.com/backend-api?proxy=x",
    "https://chatgpt.com/backend-api#x", "https://chatgpt.com/unexpected", "not a URL"];
  for (const url of urls) {
    let resolved = 0;
    const runtime = registry(token());
    const original = runtime.getApiKeyAndHeaders;
    runtime.getApiKeyAndHeaders = async (m) => { resolved++; return original(m); };
    assert.equal(officialBase("openai-codex", url), false);
    await assert.rejects(resolveIdentity(model("openai-codex", url), runtime, signal(), now));
    assert.equal(resolved, 0);
    await assert.rejects(resolveIdentity(model(), registry(token(), { baseUrl: url }), signal(), now));
  }
  await assert.rejects(resolveIdentity(model("deepseek", "https://proxy.example/v1"), registry("proxy-key"), signal(), now));
  await assert.rejects(resolveIdentity(model("other"), registry("key"), signal(), now));
  for (const url of ["https://api.deepseek.com", "https://api.deepseek.com/", "https://api.deepseek.com/v1/"]) {
    assert.equal(officialBase("deepseek", url), true);
  }
});

test("ambiguous header auth, non-OAuth Codex and malformed/expired JWTs fail closed", async () => {
  for (const headers of [{ Authorization: "Bearer another" }, { authorization: null },
    { "x-api-key": "another" }, { "chatgpt-account-id": "different-account" }]) {
    await assert.rejects(resolveIdentity(model(), registry(token(), { headers }), signal(), now));
    await assert.rejects(resolveIdentity({ ...model(), headers: headers as unknown as Model<Api>["headers"] }, registry(token()), signal(), now));
  }
  for (const invalid of ["not-oauth", "a.b.c", token("", "user"), token("x\nunsafe"), token("a", "", now / 1000 + 10),
    token("a", "user", now / 1000), token("a", "user", now / 1000 - 10)]) {
    await assert.rejects(resolveIdentity(model(), registry(invalid), signal(), now));
  }
  await assert.rejects(resolveIdentity(model(), { ...registry(token()), isUsingOAuth: () => false }, signal(), now));
  await assert.rejects(resolveIdentity(model(), registry(token(), { ok: false, error: "SECRET must never escape" }), signal(), now),
    (error: unknown) => error instanceof Error && error.message === "Authentication unavailable");
});

test("auth wait is bounded/cancellable and late auth cannot escape", async () => {
  const pending = new Promise<RuntimeAuth>(() => {});
  const runtime = { ...registry(token()), getApiKeyAndHeaders: () => pending };
  await Promise.all([
    assert.rejects(resolveIdentity(model(), runtime, signal(), now, 5), /Authentication unavailable/), delay(20),
  ]);
  const cancel = new AbortController();
  const operation = resolveIdentity(model(), runtime, cancel.signal, now);
  cancel.abort();
  await assert.rejects(operation, /Authentication unavailable/);
  await assert.rejects(resolveIdentity(model(), registry(token()), cancel.signal, now));
  let reject!: (error: Error) => void;
  const rejectedLater = new Promise<void>((_resolve, fail) => { reject = fail; });
  const stopped = abortable(rejectedLater, cancel.signal);
  await assert.rejects(stopped);
  reject(new Error("late secret"));
  await delay(0);
});

test("HTTP uses only fixed GET endpoint, limited headers and redirect:error", async () => {
  for (const provider of ["openai-codex", "deepseek"] as const) {
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls++;
      assert.equal(url, ENDPOINTS[provider]);
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.cache, "no-store");
      assert.deepEqual(init?.headers, { Accept: "application/json", Authorization: "Bearer synthetic" });
      return new Response('{"value":42}');
    };
    assert.deepEqual(await requestJson(provider, { Authorization: "Bearer synthetic" }, signal(), fetcher), { value: 42 });
    assert.equal(calls, 1);
  }
});

test("HTTP rejects errors, redirects, oversized bodies/lengths, malformed JSON/UTF8 and empty responses", async () => {
  const responses = [
    new Response("secret error", { status: 401 }), new Response("", { status: 302, headers: { Location: "https://evil.example" } }),
    new Response("{}", { headers: { "content-length": "1000000" } }),
    new Response("{}", { headers: { "content-length": "invalid" } }),
    new Response("x".repeat(100)), new Response("<html>private</html>"),
    new Response(new Uint8Array([0xff])), new Response(null),
  ];
  const redirected = new Response("{}");
  Object.defineProperty(redirected, "redirected", { value: true });
  responses.push(redirected);
  const foreign = new Response("{}");
  Object.defineProperty(foreign, "url", { value: "https://evil.example/data" });
  responses.push(foreign);
  for (const response of responses) {
    await assert.rejects(requestJson("deepseek", {}, signal(), async () => response, 100, 64),
      (error: unknown) => error instanceof Error && error.message === "Usage unavailable");
  }
  await assert.rejects(requestJson("deepseek", {}, signal(), async () => { throw new Error("Bearer SECRET"); }),
    (error: unknown) => error instanceof Error && !error.message.includes("SECRET"));
});

test("stream size limit applies across chunks and failed responses cancel their bodies", async () => {
  let cancelled = false;
  let produced = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { produced++; controller.enqueue(new Uint8Array(20)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(requestJson("deepseek", {}, signal(), async () => response, 100, 32));
  assert.equal(cancelled, true);
  assert.ok(produced <= 4);
  let errorCancelled = false;
  const failed = new Response(new ReadableStream({ cancel() { errorCancelled = true; } }), { status: 500 });
  await assert.rejects(requestJson("deepseek", {}, signal(), async () => failed));
  assert.equal(errorCancelled, true);
});

test("a late fetch response after cancellation has its body cancelled", async () => {
  let complete!: (value: Response) => void;
  const response = new Promise<Response>((resolve) => { complete = resolve; });
  const abort = new AbortController();
  const operation = requestJson("deepseek", {}, abort.signal, async () => response);
  abort.abort();
  await assert.rejects(operation);
  let cancelled = false;
  complete(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await delay(0);
  assert.equal(cancelled, true);
});

test("timeout and shutdown cancel fetch/body reads even with non-cooperating mocks", async () => {
  let received: AbortSignal | undefined;
  const stalled: typeof fetch = async (_url, init) => {
    assert.ok(init?.signal);
    received = init.signal;
    return new Promise(() => {});
  };
  await Promise.all([assert.rejects(requestJson("deepseek", {}, signal(), stalled, 5)), delay(20)]);
  assert.equal(received?.aborted, true);
  let cancelled = false;
  const body = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await Promise.all([assert.rejects(requestJson("deepseek", {}, signal(), async () => body, 5)), delay(20)]);
  assert.equal(cancelled, true);
  const abort = new AbortController();
  const operation = requestJson("deepseek", {}, abort.signal, stalled, 1000);
  abort.abort();
  await assert.rejects(operation);
  let called = false;
  await assert.rejects(requestJson("deepseek", {}, abort.signal, async () => { called = true; return new Response("{}"); }));
  assert.equal(called, false);
});
