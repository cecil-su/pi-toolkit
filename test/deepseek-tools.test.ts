import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { DEEPSEEK_ENDPOINTS, DeepSeekPostGate } from "../src/deepseek-http.ts";
import { registerDeepSeekTools } from "../src/deepseek-tools.ts";
import { fetchData, fetchInput, publicWebUrl, searchData, searchInput, WEB_DATA_BYTES, WEB_OUTPUT_BYTES, WEB_WARNING } from "../src/deepseek-web.ts";
import statusbar from "../src/index.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Auth = Awaited<ReturnType<ExtensionToolContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
const deepseek = { provider: "deepseek", id: "synthetic-deepseek", api: "openai-completions", name: "Synthetic DeepSeek", baseUrl: "https://api.deepseek.com/v1" } as Model<Api>;
const row = (overrides = {}) => ({ title: "Synthetic title", url: "https://example.com/article?a=1&b=2#part", snippet: "Short snippet", summary: "Synthetic summary",
  content: "UNUSED_FULL_CONTENT", rerank_score: 2.4, date: null, site_name: null, site_icon: null, authority: 1, ...overrides });

function harness(clock: () => number = Date.now) {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionToolContext) => unknown)[]>();
  let auth: Auth = { ok: true, apiKey: "synthetic-key-a" };
  let models = [deepseek], authCalls = 0, registryReads = 0;
  let authResolver: (() => Promise<Auth>) | undefined;
  const ctx = { mode: "rpc", hasUI: false, model: { provider: "openai-codex", id: "synthetic-gpt", baseUrl: "https://chatgpt.com/backend-api", api: "openai-codex-responses" },
    modelRegistry: {
      getAll() { registryReads++; return models; },
      async getApiKeyAndHeaders(model: Model<Api>) { authCalls++; assert.equal(model.provider, "deepseek"); return authResolver ? authResolver() : auth; },
      isUsingOAuth: () => false, getProvider: () => undefined, getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
    }, ui: { setFooter() {}, notify() {} }, getContextUsage: () => undefined,
  } as unknown as ExtensionToolContext;
  const api = {
    registerTool(tool: Tool) { assert.ok(!tools.has(tool.name)); tools.set(tool.name, tool); },
    registerCommand() {},
    on(name: string, handler: (event: unknown, context: ExtensionToolContext) => unknown) {
      const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {};
    },
  } as unknown as ExtensionAPI;
  return { api, ctx, tools, gate: new DeepSeekPostGate(clock),
    auth(value: Auth) { auth = value; }, models(value: Model<Api>[]) { models = value; }, pending(value: () => Promise<Auth>) { authResolver = value; },
    counts: () => ({ authCalls, registryReads }),
    async fire(name: string) { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); },
    async call(name: string, params: unknown, signal?: AbortSignal) {
      const tool = tools.get(name); assert.ok(tool);
      return tool.execute("synthetic-call", params, signal, undefined, ctx);
    },
  };
}

test("both tools register without side effects; explicit calls work in every mode and do not replace other search tools", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const intervals = t.mock.method(globalThis, "setInterval");
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    requests++;
    assert.ok(url === DEEPSEEK_ENDPOINTS.search || url === DEEPSEEK_ENDPOINTS.fetch);
    return new Response(JSON.stringify(url === DEEPSEEK_ENDPOINTS.search ? { results: [] } : { title: "Title", content: "Page" }));
  });
  for (const mode of ["tui", "print", "json", "rpc"] as const) {
    const h = harness();
    h.ctx.mode = mode;
    assert.ok(h.ctx.model);
    h.ctx.model = { ...h.ctx.model, provider: "openai" }; // Existing TUI footer/Fast have no supported current provider here.
    const other = { name: "codex_web_search" } as Tool;
    h.tools.set("codex_web_search", other);
    const before = requests, timerCount = intervals.mock.calls.length;
    statusbar(h.api, { load: async () => { assert.fail("Fast must not read preferences without a binding"); }, save: async () => {} });
    assert.equal(intervals.mock.calls.length, timerCount, "factory starts no timers");
    assert.deepEqual([...h.tools.keys()], ["codex_web_search", "deepseek_search", "deepseek_fetch"]);
    assert.equal(h.tools.get("codex_web_search"), other);
    assert.deepEqual(h.counts(), { authCalls: 0, registryReads: 0 });
    await h.fire("session_start"); await h.fire("model_select"); await settle();
    assert.equal(requests, before);
    assert.deepEqual(h.counts(), { authCalls: 0, registryReads: 0 });
    if (mode !== "tui") assert.equal(intervals.mock.calls.length, timerCount);
    for (const name of ["deepseek_search", "deepseek_fetch"]) {
      const tool = h.tools.get(name); assert.ok(tool);
      assert.equal(tool.annotations?.readOnlyHint, true); assert.equal(tool.annotations?.openWorldHint, true);
      assert.equal(tool.annotations?.idempotentHint, false);
      assert.equal((tool.parameters as { additionalProperties?: boolean }).additionalProperties, false);
      assert.ok(tool.outputSchema);
      assert.match(tool.description, /CNY 5\/1000/); assert.match(tool.description, /No automatic POST retries/);
    }
    const found = await h.call("deepseek_search", { query: "Synthetic search" });
    assert.deepEqual((found.details as ReturnType<typeof searchData>).results, []);
    const fetched = await h.call("deepseek_fetch", { url: "https://example.com/page" });
    assert.equal((fetched.details as ReturnType<typeof fetchData>).content, "Page");
    assert.equal(requests, before + 2);
    assert.equal(h.counts().authCalls, 2);
    await h.fire("session_shutdown");
  }
});

test("cross-model auth selects only official DeepSeek without switching GPT; POST contains only query/count", async (t) => {
  const h = harness(); registerDeepSeekTools(h.api, h.gate);
  const current = h.ctx.model;
  h.models([{ ...deepseek, id: "proxy", baseUrl: "https://proxy.example/v1" }, deepseek]);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit) => {
    calls++;
    assert.equal(url, DEEPSEEK_ENDPOINTS.search);
    assert.deepEqual(JSON.parse(options.body as string), { query: "合成😀 site:example.com", count: 5 });
    assert.deepEqual(options.headers, { Accept: "application/json", "Content-Type": "application/json", Authorization: "Bearer synthetic-key-a" });
    return new Response(JSON.stringify({ results: [row(), row({ date: "2026-01-01T00:00:00Z", site_name: "Site", authority: null })] }));
  });
  const result = await h.call("deepseek_search", { query: "合成😀 site:example.com" });
  assert.equal(calls, 1); assert.equal(h.ctx.model, current);
  const data = result.details as ReturnType<typeof searchData>;
  assert.equal(data.results.length, 2); assert.equal(data.results[0].url, row().url);
  assert.equal(data.warning, WEB_WARNING); assert.equal(data.truncated, false);
  assert.deepEqual(result.structuredContent, result.details);
  assert.match(JSON.stringify(result.content), /UNTRUSTED.*NEVER.*Cite/);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-key-a|UNUSED_FULL_CONTENT|rerank_score|site_icon|authority/);
});

test("proxy-only models, auth-target overrides, conflicting headers and missing keys fail without POST or secret echoes", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { assert.fail("rejected auth must not POST"); });
  const variants: { models?: Model<Api>[]; auth?: Auth; expected: RegExp; reads?: number }[] = [
    { models: [], expected: /No official DeepSeek model/, reads: 0 },
    { models: [{ ...deepseek, baseUrl: "https://proxy.example/v1" }], expected: /No official DeepSeek model/, reads: 0 },
    { models: [{ ...deepseek, baseUrl: "https://api.deepseek.com.evil.example/v1" }], expected: /No official DeepSeek model/, reads: 0 },
    { auth: { ok: true }, expected: /API key unavailable/ },
    { auth: { ok: false, error: "PRIVATE synthetic-key-a" }, expected: /API key unavailable/ },
    { auth: { ok: true, apiKey: "synthetic-key-a", baseUrl: "https://proxy.example/v1" }, expected: /target\/headers rejected/ },
    { auth: { ok: true, apiKey: "synthetic-key-a", baseUrl: "https://api.deepseek.com/v1" }, expected: /target\/headers rejected/ },
  ];
  const conflicting: Record<string, string>[] = [{ Authorization: "Bearer PRIVATE" }, { "proxy-authorization": "PRIVATE" }, { "X-API-KEY": "PRIVATE" }, { "api-key": "PRIVATE" }];
  for (const headers of conflicting) {
    variants.push({ auth: { ok: true, apiKey: "synthetic-key-a", headers }, expected: /target\/headers rejected/ });
    variants.push({ models: [{ ...deepseek, headers }], expected: /target\/headers rejected/ });
  }
  for (const variant of variants) {
    const h = harness(); registerDeepSeekTools(h.api, h.gate);
    if (variant.models) h.models(variant.models);
    if (variant.auth) h.auth(variant.auth);
    await assert.rejects(h.call("deepseek_search", { query: "synthetic" }), (error: unknown) => {
      assert.ok(error instanceof Error); assert.match(error.message, variant.expected);
      assert.doesNotMatch(error.message, /PRIVATE|synthetic-key-a/); return true;
    });
    assert.equal(h.counts().authCalls, variant.reads ?? 1);
  }
});

test("Unicode query/count and strict unknown-field validation happen before registry/auth/HTTP", async (t) => {
  const h = harness(); registerDeepSeekTools(h.api, h.gate);
  t.mock.method(globalThis, "fetch", async () => { assert.fail("invalid arguments"); });
  const bad = [null, [], {}, { query: "" }, { query: " \t\n" }, { query: "a".repeat(129) }, { query: "😀".repeat(129) },
    { query: "x\u001b[31m" }, { query: "x\u202e" }, { query: "\ud800" }, { query: 1 },
    ...[0, 51, 1.5, NaN, Infinity, "5", null].map((count) => ({ query: "x", count })),
    { query: "x", need_content: false }, { query: "x", ori_question: "PRIVATE" }, { query: "x", localization: "PRIVATE" }, { query: "x", unexpected: true }];
  for (const value of bad) await assert.rejects(h.call("deepseek_search", value));
  for (const value of [null, [], {}, { url: 1 }, { url: "https://example.com", unexpected: true }]) await assert.rejects(h.call("deepseek_fetch", value));
  assert.deepEqual(h.counts(), { authCalls: 0, registryReads: 0 });
  assert.deepEqual(searchInput({ query: "😀".repeat(128) }), { query: "😀".repeat(128), count: 5 });
  assert.deepEqual(searchInput({ query: " x ", count: 1 }), { query: "x", count: 1 });
  assert.equal(searchInput({ query: "中文😀", count: 50 }).count, 50);
});

test("public URL validation blocks normalized IP, userinfo, local-name and control/backslash bypasses before auth", async (t) => {
  const h = harness(); registerDeepSeekTools(h.api, h.gate);
  t.mock.method(globalThis, "fetch", async () => { assert.fail("invalid URLs"); });
  const urls = ["file:///etc/passwd", "ftp://example.com", "javascript:alert(1)", "//example.com", "https:example.com", "https://", "not a URL",
    "https://user:pass@example.com", "https://user%40x@example.com", "https://@example.com", "http://127.0.0.1", "http://127.1", "http://2130706433",
    "http://0x7f000001", "http://0177.0.0.1", "http://10.0.0.1", "http://172.16.0.1", "http://192.168.1.1", "http://169.254.169.254",
    "https://8.8.8.8", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://[fc00::1]", "http://[fe80::1]", "https://localhost", "https://LOCALHOST.",
    "https://localhost.localdomain", "https://host.local", "https://metadata.google.internal", "https://intranet", "https://host.home.arpa",
    "https://127.0.0.1.nip.io", "https://host.lan", "https://localtest.me", "https://example.com\\@localhost", "https://example.com\n.localhost",
    "https://example.com/%0aPRIVATE", "https://example.com/\u202e", "https://example.com/\u0000", `https://example.com/${"a".repeat(8192)}`];
  for (const url of urls) await assert.rejects(h.call("deepseek_fetch", { url }), (error: unknown) => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /PRIVATE/); return true;
  }, url);
  assert.deepEqual(h.counts(), { authCalls: 0, registryReads: 0 });
  for (const url of ["https://example.com/path?q=a%20b#part", "http://www.example.com:8080/a", "https://例子.com/测试"]) {
    assert.equal(fetchInput({ url }).url, new URL(url).href);
  }
  const longest = `https://example.com/${"x".repeat(8192 - "https://example.com/".length)}`;
  assert.equal(publicWebUrl(longest), longest);
});

test("search/fetch consume only required fields, accept empty results, reject malformed response shapes safely", () => {
  assert.deepEqual(searchData({ results: [] }, 5), { warning: WEB_WARNING, results: [], truncated: false });
  const invalid = [null, [], {}, { results: null }, { results: [null] }, { results: [row({ title: 1 })] },
    { results: [row({ url: "file:///PRIVATE" })] }, { results: [row({ summary: null })] }, { results: [row({ snippet: null })] },
    { results: Array.from({ length: 51 }, () => row()) }];
  for (const value of invalid) assert.throws(() => searchData(value, 5), /Usage unavailable/);
  for (const value of [null, {}, { title: "PRIVATE" }, { title: null, content: "PRIVATE" }, { title: "PRIVATE", content: [] }]) {
    assert.throws(() => fetchData(value, "https://example.com"), /Usage unavailable/);
  }
  assert.equal(fetchData({ title: "", content: "" }, "https://example.com").content, "");
  assert.throws(() => fetchData({ title: "", content: "x" }, `https://example.com/${"x".repeat(50000)}`), /Usage unavailable/);
  assert.equal(searchData({ results: [row({ summary: "", snippet: "Fallback" })] }, 5).results[0].summary, "Fallback");
});

test("bounded output and details/structuredContent preserve complete source URLs, mark truncation, remove terminal/control codes", async (t) => {
  const h = harness(); registerDeepSeekTools(h.api, h.gate);
  const source = `https://example.com/${"a".repeat(7000)}?q=1&second=2#fragment`;
  const rows = Array.from({ length: 50 }, (_, i) => row({ url: `${source}${i}`, title: `\x1b[31mTitle\x1b[0m\u202e\u0000${"T".repeat(1000)}`,
    summary: `${"S".repeat(5000)}PRIVATE_TAIL_SENTINEL`, content: "UNUSED_PRIVATE_BODY" }));
  t.mock.method(globalThis, "fetch", async (url: unknown) => new Response(JSON.stringify(url === DEEPSEEK_ENDPOINTS.search
    ? { results: rows } : { title: "\x1b[31mTitle\x1b[0m\u202e", content: `${"\"\\".repeat(100000)}PRIVATE_TAIL_SENTINEL` })));
  const search = await h.call("deepseek_search", { query: "synthetic", count: 50 });
  const data = search.details as ReturnType<typeof searchData>;
  assert.equal(data.truncated, true); assert.ok(data.results.length > 0 && data.results.length < 50);
  assert.ok(data.results.every((value, index) => value.url === rows[index].url));
  assert.ok(data.results.every((value) => value.truncated && value.summary.startsWith("S")));
  const fetched = await h.call("deepseek_fetch", { url: source });
  assert.equal((fetched.details as ReturnType<typeof fetchData>).url, source);
  for (const value of [search, fetched]) {
    assert.deepEqual(value.details, value.structuredContent);
    assert.ok(Buffer.byteLength(JSON.stringify(value.details), "utf8") <= WEB_DATA_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(value.structuredContent), "utf8") <= WEB_OUTPUT_BYTES);
    const text = value.content[0]; assert.equal(text.type, "text");
    if (text.type !== "text") assert.fail("text expected");
    assert.ok(Buffer.byteLength(text.text, "utf8") <= WEB_OUTPUT_BYTES);
    assert.match(text.text, /OUTPUT TRUNCATED/); assert.match(text.text, /UNTRUSTED.*NEVER.*Cite/);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_TAIL_SENTINEL|UNUSED_PRIVATE_BODY|synthetic-key-a|\\u001b|\u202e/);
  }
});

test("near-budget multibyte search data leaves room for warnings in model content, details and structuredContent", async (t) => {
  const rows = Array.from({ length: 5 }, (_, index) => row({ url: `https://example.com/${index}/${"u".repeat(4500)}`,
    title: "合成标题", summary: `${"搜".repeat(1000)}PRIVATE_TAIL_SENTINEL` }));
  const initial = searchData({ results: rows }, 5);
  assert.equal(initial.results.length, 5);
  const padding = WEB_DATA_BYTES - Buffer.byteLength(JSON.stringify(initial), "utf8") - 1;
  assert.ok(padding > 0);
  rows[4].url += "x".repeat(padding);
  const h = harness(); registerDeepSeekTools(h.api, h.gate);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ results: rows })));
  const value = await h.call("deepseek_search", { query: "合成", count: 5 });
  const data = value.details as ReturnType<typeof searchData>;
  assert.equal(data.truncated, true); assert.equal(data.results.length, 5);
  assert.ok(data.results.every((item) => item.summary.startsWith("搜")));
  assert.deepEqual(data.results.map((item) => item.url), rows.map((item) => item.url));
  assert.ok(Buffer.byteLength(JSON.stringify(value.details), "utf8") >= WEB_DATA_BYTES - 2);
  assert.ok(Buffer.byteLength(JSON.stringify(value.details), "utf8") <= WEB_OUTPUT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(value.structuredContent), "utf8") <= WEB_OUTPUT_BYTES);
  const text = value.content[0]; assert.equal(text.type, "text");
  if (text.type !== "text") assert.fail("text expected");
  assert.ok(Buffer.byteLength(text.text, "utf8") <= WEB_OUTPUT_BYTES);
  assert.match(text.text, /OUTPUT TRUNCATED/);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_TAIL_SENTINEL/);
});

test("HTTP/shape failures never leak response bodies, keys, headers or provider messages and never auto-replay", async (t) => {
  let calls = 0;
  for (const status of [400, 401, 402, 403, 404, 408, 413, 429, 500, 504]) {
    const h = harness(); registerDeepSeekTools(h.api, h.gate);
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("PRIVATE synthetic-key-a", { status, headers: { "X-Private": "PRIVATE" } }); });
    const before = calls;
    await assert.rejects(h.call("deepseek_search", { query: "x" }), (error: unknown) => {
      assert.ok(error instanceof Error); assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.match(error.message, /No automatic retry.*billing may be uncertain/);
      if (status === 401) assert.match(error.message, /Configure a valid official DeepSeek API key/);
      else if (status === 402) assert.match(error.message, /Top up or check the DeepSeek account balance/);
      else assert.match(error.message, /Retry explicitly later/);
      assert.doesNotMatch(error.message, /PRIVATE|synthetic-key-a|X-Private/); return true;
    });
    assert.equal(calls, before + 1);
  }
  const h = harness(); registerDeepSeekTools(h.api, h.gate);
  t.mock.method(globalThis, "fetch", async () => new Response('{"results":[{"PRIVATE":"synthetic-key-a"}]}'));
  await assert.rejects(h.call("deepseek_search", { query: "x" }), (error: unknown) => {
    assert.ok(error instanceof Error); assert.match(error.message, /invalid/); assert.doesNotMatch(error.message, /PRIVATE|synthetic-key-a/); return true;
  });
});

test("concurrent calls and key/model changes cannot bypass endpoint 429 deadlines (seconds and HTTP-date)", async (t) => {
  for (const date of [false, true]) {
    let clock = 1_800_000_000_000, calls = 0;
    t.mock.method(Date, "now", () => clock);
    const h = harness(() => clock); registerDeepSeekTools(h.api, h.gate);
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    let slow = true;
    t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
      calls++;
      if (url === DEEPSEEK_ENDPOINTS.fetch) return new Response('{"title":"","content":"ok"}');
      if (slow) return pending;
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer synthetic-key-b");
      return new Response('{"results":[]}');
    });
    const first = h.call("deepseek_search", { query: "x" }); await settle();
    h.auth({ ok: true, apiKey: "synthetic-key-b" });
    await assert.rejects(h.call("deepseek_search", { query: "x" }), /busy/);
    assert.equal(calls, 1);
    await h.call("deepseek_fetch", { url: "https://example.com" });
    assert.equal(calls, 2);
    finish(new Response("PRIVATE", { status: 429, headers: { "retry-after": date ? new Date(clock + 120000).toUTCString() : "120" } }));
    await assert.rejects(first, /HTTP 429/);
    slow = false;
    h.ctx.model = deepseek;
    clock += 119999;
    await assert.rejects(h.call("deepseek_search", { query: "x" }), /throttled/);
    assert.equal(calls, 2); assert.equal(h.counts().authCalls, 2, "blocked calls do not resolve auth");
    clock++;
    await h.call("deepseek_search", { query: "x" }); assert.equal(calls, 3);
  }
});

test("pre-aborted and in-flight auth/tool cancellation do not POST and late auth is ignored", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { assert.fail("cancelled auth must not POST"); });
  const h = harness(); registerDeepSeekTools(h.api, h.gate);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(h.call("deepseek_search", { query: "x" }, aborted.signal), /cancelled/);
  assert.equal(h.counts().authCalls, 0);
  h.ctx.signal = aborted.signal;
  await assert.rejects(h.call("deepseek_search", { query: "x" }), /cancelled/);
  h.ctx.signal = undefined;
  assert.equal(h.counts().authCalls, 0);
  let resolve!: (value: Auth) => void;
  h.pending(() => new Promise<Auth>((done) => { resolve = done; }));
  const controller = new AbortController();
  const operation = h.call("deepseek_search", { query: "x" }, controller.signal);
  await settle(); controller.abort();
  await assert.rejects(operation, /cancelled/);
  resolve({ ok: true, apiKey: "synthetic-key-a" }); await settle();
  assert.equal(h.counts().authCalls, 1);
});
