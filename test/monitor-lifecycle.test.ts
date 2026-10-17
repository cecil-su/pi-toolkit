import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Identity } from "../src/auth.ts";
import type { UsageView } from "../src/data.ts";
import statusbar from "../src/index.ts";
import { UsageMonitor } from "../src/monitor.ts";

function identity(scope: string, provider: Identity["provider"] = "deepseek"): Identity {
  return { provider, scope, modelId: "synthetic-model", headers: {}, account: "synthetic-account" };
}
const balance = (amount = "123.4500") => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: amount }] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { await settle(); }
function deepSeekAmount(view: UsageView): string {
  if (view.status !== "ready" || view.usage.provider !== "deepseek") assert.fail("Expected ready DeepSeek balance");
  return view.usage.balances[0].amount;
}
function readyProvider(view: UsageView): string {
  if (view.status !== "ready") assert.fail("Expected ready usage");
  return view.usage.provider;
}

test("auth checks are low frequency, GETs once/minute, and same-account checks don't flash loading", async () => {
  let time = 0, authCalls = 0, getCalls = 0;
  let pending: ReturnType<typeof deferred<Identity>> | undefined;
  const monitor = new UsageMonitor(async () => { authCalls++; return pending ? pending.promise : identity("a"); },
    () => {}, async () => { getCalls++; return balance(); }, () => time);
  await monitor.poll(); await flush();
  assert.equal(monitor.view().status, "ready");
  assert.equal(authCalls, 2); // Request auth and post-response account verification.
  for (time = 1000; time < 10000; time += 1000) await monitor.poll();
  assert.equal(authCalls, 2);
  pending = deferred<Identity>();
  const check = monitor.poll();
  assert.equal(monitor.view().status, "ready"); // Same authenticated lease; no loading flicker.
  pending.resolve(identity("a"));
  await check;
  assert.equal(monitor.view().status, "ready");
  for (time = 11000; time <= 60000; time += 1000) { await monitor.poll(); await flush(); }
  assert.equal(getCalls, 2);
  assert.ok(authCalls <= 9);
  monitor.stop();
});

test("unavailable/unsupported authentication is throttled rather than resolved every second", async () => {
  for (const unsupported of [false, true]) {
    let time = 0, calls = 0;
    const monitor = new UsageMonitor(async () => {
      calls++;
      if (unsupported) return undefined;
      throw new Error("synthetic failure");
    }, () => {}, async () => { throw new Error("must not fetch"); }, () => time);
    for (time = 0; time < 10000; time += 1000) await monitor.poll();
    assert.equal(calls, 1);
    assert.equal(monitor.view().status, unsupported ? "unsupported" : "unavailable");
    time = 10000; await monitor.poll();
    assert.equal(calls, 2);
    monitor.stop();
  }
});

test("successful old-account snapshot disappears before a new-account response arrives", async () => {
  let current = identity("a");
  const waiting = deferred<unknown>();
  const monitor = new UsageMonitor(async () => current, () => {}, async (id) => id.scope === "a" ? balance("999") : waiting.promise);
  await monitor.poll(); await flush();
  assert.equal(monitor.view().status, "ready");
  current = identity("b");
  await monitor.poll(true);
  assert.equal(monitor.view().status, "loading");
  waiting.resolve(balance("1")); await flush();
  const view = monitor.view();
  assert.equal(view.status, "ready");
  if (view.status === "ready" && view.usage.provider === "deepseek") assert.equal(view.usage.balances[0].amount, "1");
  monitor.stop();
});

test("stalled auth cannot extend a lease or hide JWT expiry", async () => {
  let time = 0;
  let stalled = false;
  const pending = deferred<Identity>();
  const monitor = new UsageMonitor(async () => stalled ? pending.promise : { ...identity("a"), expiresAt: 14000 },
    () => {}, async () => balance(), () => time);
  await monitor.poll(); await flush();
  time = 10000; stalled = true;
  const check = monitor.poll();
  assert.equal(monitor.view().status, "ready");
  time = 14000;
  assert.equal(monitor.view().status, "stale");
  monitor.stop(); pending.resolve(identity("a")); await check;
  assert.notEqual(monitor.view().status, "ready");
});

test("account switch clears successful snapshot; late old results cannot overwrite new account", async () => {
  let current = identity("a"), changed = 0;
  const old = deferred<unknown>();
  let oldSignal: AbortSignal | undefined;
  const monitor = new UsageMonitor(async () => current, () => { changed++; }, async (id, signal) => {
    if (id.scope === "a") { oldSignal = signal; return old.promise; }
    return balance("2.000");
  });
  await monitor.poll();
  current = identity("b");
  await monitor.poll(true); await flush();
  assert.equal(oldSignal?.aborted, true);
  assert.deepEqual(monitor.view(), { status: "ready", usage: { provider: "deepseek", available: true,
    balances: [{ currency: "CNY", amount: "2.000" }] } });
  old.resolve(balance("999.000")); await flush();
  assert.equal(deepSeekAmount(monitor.view()), "2.000");
  assert.ok(changed > 0);
  monitor.stop();
});

test("post-response revalidation rejects a silent account switch before the periodic check", async () => {
  let current = identity("a");
  const response = deferred<unknown>();
  const monitor = new UsageMonitor(async () => current, () => {}, async () => response.promise);
  await monitor.poll();
  current = identity("b"); response.resolve(balance("999")); await flush();
  assert.equal(monitor.view().status, "loading");
  monitor.stop();
});

test("provider/model invalidation aborts requests, retries cleanly and never reuses old data", async () => {
  let current: Identity | undefined = identity("a", "openai-codex");
  const old = deferred<unknown>();
  let oldSignal: AbortSignal | undefined;
  const monitor = new UsageMonitor(async () => current, () => {}, async (id, signal) => {
    if (id.provider === "openai-codex") { oldSignal = signal; return old.promise; }
    return balance();
  });
  await monitor.poll();
  monitor.invalidate(); current = identity("b");
  await monitor.poll(); await flush();
  assert.equal(oldSignal?.aborted, true);
  assert.equal(readyProvider(monitor.view()), "deepseek");
  old.resolve({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }); await flush();
  assert.equal(readyProvider(monitor.view()), "deepseek");
  current = undefined;
  await monitor.poll(true);
  assert.equal(monitor.view().status, "unsupported");
  monitor.stop();
});

test("failed quota/auth never replays a previous success; stale payload is hidden", async () => {
  let time = 0, fail = false, failAuth = false;
  const monitor = new UsageMonitor(async () => { if (failAuth) throw new Error("secret"); return identity("a"); },
    () => {}, async () => { if (fail) throw new Error("secret"); return balance(); }, () => time);
  await monitor.poll(); await flush();
  time = 90000;
  assert.equal(monitor.view().status, "stale");
  fail = true;
  await monitor.poll(true); await flush();
  assert.equal(monitor.view().status, "unavailable");
  fail = false; monitor.invalidate();
  await monitor.poll(); await flush();
  assert.equal(monitor.view().status, "ready");
  failAuth = true;
  await monitor.poll(true);
  assert.equal(monitor.view().status, "unavailable");
  monitor.stop();
});

test("stop is idempotent and cancels pending auth/request without late notifications", async () => {
  const waiting = deferred<Identity>();
  let authSignal: AbortSignal | undefined;
  let changes = 0;
  const monitor = new UsageMonitor(async (signal) => { authSignal = signal; return waiting.promise; }, () => { changes++; });
  const poll = monitor.poll();
  monitor.stop(); monitor.stop();
  assert.equal(authSignal?.aborted, true);
  waiting.resolve(identity("a")); await poll;
  assert.equal(changes, 0);
  await monitor.poll();
  assert.equal(changes, 0);
  const response = deferred<unknown>();
  let requestSignal: AbortSignal | undefined;
  const pending = new UsageMonitor(async () => identity("a"), () => { changes++; }, async (_id, signal) => {
    requestSignal = signal; return response.promise;
  });
  await pending.poll();
  pending.stop(); const before = changes;
  assert.equal(requestSignal?.aborted, true);
  response.resolve(balance()); await flush();
  assert.equal(changes, before);
});

type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
type TestHandler = (event: unknown, context: unknown) => unknown;
function harness() {
  const handlers = new Map<string, TestHandler>();
  let footer: ReturnType<FooterFactory> | undefined;
  let branch: string | null = "synthetic-branch";
  let factoryCount = 0, resets = 0, subscriptions = 0, renders = 0, authCalls = 0;
  const context = {
    mode: "tui" as ExtensionContext["mode"], hasUI: true,
    thinkingLevel: "high" as ExtensionContext["thinkingLevel"],
    model: { provider: "deepseek", id: "synthetic-model", name: "Runtime Name 测试", api: "openai-completions", baseUrl: "https://api.deepseek.com" } as Model<Api>,
    modelRegistry: {
      async getApiKeyAndHeaders() { authCalls++; return { ok: true, apiKey: "synthetic-key" }; },
      isUsingOAuth() { return false; },
    },
    getContextUsage: (): ContextUsage | undefined => ({ tokens: 25, contextWindow: 100, percent: 25 }),
    ui: {
      theme: { fg(_color: string, text: string) { return text; } } as Parameters<FooterFactory>[1],
      setFooter(factory: FooterFactory | undefined) {
      const old = footer; footer = undefined; old?.dispose?.();
      if (!factory) { resets++; return; }
      factoryCount++;
      footer = factory({ requestRender() { renders++; } } as Parameters<FooterFactory>[0],
        context.ui.theme, {
          getGitBranch() { return branch; },
          getExtensionStatuses() { return new Map(); },
          getAvailableProviderCount() { return 1; },
          onBranchChange() { subscriptions++; return () => { subscriptions--; }; },
        });
    } },
  };
  statusbar({ on(name: string, handler: TestHandler) { handlers.set(name, handler); return () => {}; } } as unknown as ExtensionAPI);
  return {
    context, handlers,
    setBranch(value: string | null) { branch = value; },
    fire(name: string) { return handlers.get(name)?.({ type: name }, context); },
    footer: () => { assert.ok(footer); return footer; },
    counts: () => ({ factoryCount, resets, subscriptions, renders, authCalls }),
  };
}

test("extension factory is side-effect-free; non-TUI sessions never authenticate or install a footer", async () => {
  const h = harness();
  assert.equal(h.counts().authCalls, 0);
  for (const mode of ["print", "json", "rpc"] as const) {
    h.context.mode = mode;
    h.fire("session_start"); await flush();
    assert.deepEqual(h.counts(), { factoryCount: 0, resets: 0, subscriptions: 0, renders: 0, authCalls: 0 });
  }
});

test("footer reload/replacement/shutdown clears timers, requests, subscriptions and ownership", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { fetchCalls++; return new Response(JSON.stringify(balance())); });
  const h = harness();
  h.fire("session_start"); await flush();
  assert.equal(fetchCalls, 1);
  assert.equal(h.counts().subscriptions, 1);
  const first = h.footer();
  assert.match(first.render(200).join(" "), /Runtime Name 测试.*ctx 75%\/100.*synthetic-branch.*CNY 123.4500/);
  h.fire("session_before_compact");
  assert.match(first.render(200).join(" "), /ctx \?\/100/);
  h.context.getContextUsage = () => ({ tokens: null, contextWindow: 100, percent: null });
  h.fire("session_compact");
  assert.match(first.render(200).join(" "), /ctx \?\/100/);
  h.fire("session_start"); await flush();
  assert.equal(h.counts().subscriptions, 1);
  assert.deepEqual(first.render(80), []);
  const current = h.footer();
  // Another footer owner disposes this component; no restoration may clobber that owner.
  current.dispose?.();
  const before = h.counts();
  t.mock.timers.tick(120000); await flush();
  assert.deepEqual(h.counts(), before);
  h.fire("session_shutdown");
  assert.equal(h.counts().resets, before.resets);
  h.fire("session_start"); await flush();
  h.fire("session_shutdown");
  assert.equal(h.counts().subscriptions, 0);
  const stopped = h.counts();
  t.mock.timers.tick(120000); await flush();
  assert.deepEqual(h.counts(), stopped);
});

test("thinking changes repaint immediately without quota refresh, and context windows survive compaction/fallback", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; return new Response(JSON.stringify(balance())); });
  const h = harness();
  h.context.model.contextWindow = 272000;
  h.context.getContextUsage = () => ({ tokens: 50000, contextWindow: 500000, percent: 10 });
  h.fire("session_start"); await flush();
  const component = h.footer();
  assert.match(component.render(200).join(""), /Runtime Name 测试 \| high \| ctx 90%\/500k/);
  const before = h.counts();
  const initialFetches = fetches;
  h.context.thinkingLevel = "off";
  h.fire("thinking_level_select");
  assert.equal(h.counts().renders, before.renders + 1);
  assert.equal(h.counts().authCalls, before.authCalls);
  assert.equal(fetches, initialFetches);
  assert.match(component.render(200).join(""), /Runtime Name 测试 \| off \| ctx 90%\/500k/);
  h.fire("session_before_compact");
  assert.match(component.render(200).join(""), /ctx \?\/500k/);
  h.context.getContextUsage = () => ({ tokens: null, contextWindow: 500000, percent: null });
  h.fire("session_compact");
  assert.match(component.render(200).join(""), /ctx \?\/500k/);
  h.context.getContextUsage = () => undefined;
  assert.match(component.render(200).join(""), /ctx \?\/272k/);
  h.context.model.contextWindow = NaN;
  assert.match(component.render(200).join(""), /ctx \?\/\?/);
  for (const branch of [null, "", " \t\n "]) {
    h.setBranch(branch);
    assert.doesNotMatch(component.render(200).join(""), /branch:|\|\s*\|/);
  }
  h.setBranch("main");
  assert.match(component.render(200).join(""), /branch: main/);
  h.fire("session_shutdown");
});

test("footer rendering uses the current UI theme, not the theme captured at mount", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness();
  const painted: { theme: string; body: string }[] = [];
  const makeTheme = (name: string) => ({
    appearance: name === "first" ? "dark" : "light",
    colors: { accent: { kind: "rgb", r: name === "first" ? 60 : 180, g: 150, b: 200 } },
    style(body: string) { painted.push({ theme: name, body }); return body; },
    getFgAnsi() { return "\x1b[2;38;5;8m"; },
    fg(_color: string, text: string) { return `\x1b[2;38;5;8m${text}\x1b[22;39m`; },
  }) as unknown as Parameters<FooterFactory>[1];
  h.context.ui.theme = makeTheme("first");
  h.context.model = { ...h.context.model, provider: "openai-codex", id: "synthetic-codex",
    api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };
  const claims = { sub: "synthetic-user", exp: Date.now() / 1000 + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } };
  const token = `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic`;
  h.context.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: token });
  h.context.modelRegistry.isUsingOAuth = () => true;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ rate_limit: {
    primary_window: { used_percent: 37, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 3600 },
    secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 86400 },
  } })));
  h.fire("session_start"); await flush();
  const component = h.footer();
  const first = component.render(200).join("");
  assert.deepEqual(painted.map((call) => call.theme), ["first", "first"]);
  assert.equal(painted[0].body, "██████▎   ");
  assert.ok(first.includes("[\x1b[22m")); // Fill cancels the outer muted/faint attribute.
  h.context.ui.theme = makeTheme("second");
  component.invalidate();
  component.render(200);
  assert.deepEqual(painted.map((call) => call.theme), ["first", "first", "second", "second"]);
  h.fire("session_shutdown");
});

test("model_select clears quota immediately and shutdown aborts a pending HTTP request", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const response = deferred<Response>();
  let requestSignal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.ok(init.signal);
    requestSignal = init.signal; return response.promise;
  });
  const h = harness();
  h.fire("session_start"); await flush();
  assert.ok(requestSignal);
  h.context.model = { ...h.context.model, provider: "other", id: "new-model", name: "New Runtime Model" };
  h.fire("model_select");
  assert.equal(requestSignal?.aborted, true);
  assert.doesNotMatch(h.footer().render(200).join(" "), /DeepSeek|123.4500/);
  h.fire("session_shutdown");
  response.resolve(new Response(JSON.stringify(balance()))); await flush();
  assert.equal(h.counts().subscriptions, 0);
});
