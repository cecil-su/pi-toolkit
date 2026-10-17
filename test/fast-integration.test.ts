import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { registerFast } from "../src/fast.ts";
import type { FastPreferences } from "../src/fast-preferences.ts";
import { ENDPOINTS } from "../src/http.ts";
import statusbar from "../src/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Factory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
function harness() {
  // Pi dispatches every registered handler in order; never overwrite lifecycle handlers.
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  let registration: ProviderConfig | undefined;
  const api = { registerProvider(_id: string, value: ProviderConfig) { registration = { ...registration, ...value }; },
    unregisterProvider() { registration = undefined; }, on(name: string, handler: Handler) {
    const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {};
  }, registerCommand(name: string, value: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
    commands.set(name, value.handler);
  } } as unknown as ExtensionAPI;
  let footer: ReturnType<Factory> | undefined;
  let subscriptions = 0, renders = 0, auths = 0;
  let account = "synthetic-a";
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const messages: string[] = [];
  const theme = { appearance: "dark", colors: { accent: { kind: "rgb", r: 80, g: 150, b: 190 } },
    fg(_name: string, text: string) { return text; }, getFgAnsi() { return ""; }, style(text: string) { return text; },
  } as unknown as ExtensionContext["ui"]["theme"];
  const ctx = { mode: "tui", hasUI: true, thinkingLevel: "high", model: {
    provider: "openai-codex", api: "openai-codex-responses", id: "directory-owned-model", name: "Directory Model", contextWindow: 500000,
    baseUrl: "https://chatgpt.com/backend-api",
  }, modelRegistry: {
    getRegisteredNativeProvider: () => undefined,
    getRegisteredProviderConfig: () => registration,
    getProvider: () => ({ stream(model: unknown, context: { reviewBody: unknown }, options: { onPayload?: (body: unknown, model: unknown) => unknown }) {
      return { result: async () => options.onPayload?.(context.reviewBody, model) ?? context.reviewBody };
    } }),
    async getApiKeyAndHeaders() {
      auths++;
      const claims = { sub: "synthetic-user", exp: expires,
        "https://api.openai.com/auth": { chatgpt_account_id: account } };
      return { ok: true, apiKey: `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic` };
    }, isUsingOAuth() { return true; },
  }, getContextUsage: () => ({ tokens: 50000, percent: 10, contextWindow: 500000 }),
  ui: { theme, notify(text: string) { messages.push(text); }, setFooter(factory: Factory | undefined) {
    footer?.dispose?.(); footer = undefined;
    if (factory) footer = factory({ requestRender() { renders++; } } as Parameters<Factory>[0], theme, {
      getGitBranch: () => null, getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1,
      onBranchChange() { subscriptions++; return () => { subscriptions--; }; },
    });
  } },
  } as unknown as ExtensionContext;
  return { api, ctx, handlers, commands, messages,
    account(value: string) { account = value; },
    footer() { assert.ok(footer); return footer; },
    stats: () => ({ subscriptions, renders, auths }),
    async invoke(body: unknown) {
      assert.ok(ctx.model);
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      const stream = registration?.streamSimple;
      if (!stream) return body;
      return stream(ctx.model, { messages: [], reviewBody: body } as unknown as Parameters<typeof stream>[1], { apiKey: auth.ok ? auth.apiKey : undefined }).result();
    },
    async fire(name: string, event: unknown = {}) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) {
        const next = await handler(event, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    },
  };
}

test("real combined registration: /fast + footer lifecycle, payload replacement, model/account isolation and cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const intervals = t.mock.method(globalThis, "setInterval");
  const h = harness();
  let saved = false, directories = 0, usages = 0, supported = true;
  const writes: boolean[] = [];
  const preferences: FastPreferences = { load: async () => saved, save: async (value) => { writes.push(value); saved = value; } };
  t.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit) => {
    assert.equal(options.redirect, "error");
    if (url === ENDPOINTS["codex-models"]) {
      directories++;
      assert.match((options.headers as Record<string, string>)["chatgpt-account-id"], /^synthetic-[abc]$/);
      return new Response(JSON.stringify({ models: [{ slug: h.ctx.model?.id,
        service_tiers: supported ? [{ id: "priority" }] : [] }] }));
    }
    usages++;
    return new Response(JSON.stringify({ rate_limit: { secondary_window: {
      used_percent: 100, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 3600,
    } } }));
  });
  statusbar(h.api, preferences);
  assert.equal(h.commands.has("fast"), true);
  for (const name of ["session_start", "session_shutdown", "model_select"]) assert.equal(h.handlers.get(name)?.length, 2);
  await h.fire("session_start"); await settle();
  assert.equal(intervals.mock.calls.length, 1); // Only the original footer timer while Fast is off.
  assert.equal(directories, 0); assert.equal(usages, 1); assert.equal(h.stats().subscriptions, 1);
  assert.doesNotMatch(stripTerminalSequences(h.footer().render(200).join("")), /\| fast \|/);
  const originalModel = h.ctx.model, originalThinking = h.ctx.thinkingLevel;
  await h.commands.get("fast")?.("", h.ctx);
  assert.deepEqual(writes, [true]); assert.equal(intervals.mock.calls.length, 2);
  assert.match(stripTerminalSequences(h.footer().render(200).join("")), /\| high \| fast \| ctx 90%\/500k/);
  const body = { model: h.ctx.model?.id, reasoning: { effort: "high" }, service_tier: "priority" };
  assert.deepEqual(await h.invoke(body), body);
  assert.equal(h.ctx.model, originalModel); assert.equal(h.ctx.thinkingLevel, originalThinking);
  for (let width = 0; width <= 200; width++) assert.ok(h.footer().render(width).every((line) => visibleWidth(line) <= width));
  await h.commands.get("fast")?.("", h.ctx);
  assert.deepEqual(writes, [true, false]);
  assert.equal((await h.invoke(body) as { service_tier: string }).service_tier, "default");
  assert.equal(body.service_tier, "priority");
  supported = false;
  await h.commands.get("fast")?.("", h.ctx);
  assert.deepEqual(writes, [true, false]);
  supported = true; h.account("synthetic-b");
  await h.commands.get("fast")?.("", h.ctx);
  assert.deepEqual(writes, [true, false, true]);
  h.account("synthetic-c");
  assert.equal((await h.invoke(body) as { service_tier: string }).service_tier, "default");
  assert.ok(h.ctx.model);
  h.ctx.model = { ...h.ctx.model, id: "new-directory-model", baseUrl: "https://proxy.example" };
  await h.fire("model_select");
  assert.doesNotMatch(stripTerminalSequences(h.footer().render(200).join("")), /\| fast \|/);
  assert.deepEqual(await h.invoke({ model: "new-directory-model", service_tier: "priority" }), { model: "new-directory-model", service_tier: "priority" });
  const component = h.footer();
  await h.fire("session_shutdown");
  assert.equal(h.stats().subscriptions, 0); assert.deepEqual(component.render(200), []);
  const before = h.stats(); const requests = directories + usages;
  t.mock.timers.tick(60000); await settle();
  assert.deepEqual(h.stats(), before); assert.equal(directories + usages, requests);
  assert.ok(h.messages.some((message) => message.includes("更多计划额度")));
});

test("combined multi-handler session_start keeps both account deadlines and unavailable display", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1800000000000 });
  const h = harness();
  let directories = 0, usages = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    if (url === ENDPOINTS["codex-models"]) directories++;
    else if (url === ENDPOINTS["openai-codex"]) usages++;
    else assert.fail("Unexpected endpoint");
    return new Response("synthetic limited", { status: 429, headers: { "Retry-After": "3600" } });
  });
  statusbar(h.api, { load: async () => true, save: async () => {} });
  assert.equal(h.handlers.get("session_start")?.length, 2);
  await h.fire("session_start"); await settle(); await settle();
  assert.deepEqual([directories, usages], [1, 1]);
  assert.match(stripTerminalSequences(h.footer().render(200).join("")), /Codex unavailable/);
  for (let i = 0; i < 3; i++) {
    await h.fire("session_start"); await settle(); await settle();
    await h.fire("model_select"); await settle();
    t.mock.timers.tick(10000); await settle();
    assert.deepEqual([directories, usages], [1, 1]);
    const text = stripTerminalSequences(h.footer().render(200).join(""));
    assert.match(text, /Codex unavailable/); assert.doesNotMatch(text, /loading|\| fast \|/);
  }
  await h.fire("session_shutdown");
  assert.equal(h.stats().subscriptions, 0);
});

test("Fast off creates no polling; non-TUI does not load saved preferences, discover or rewrite requests", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const intervals = t.mock.method(globalThis, "setInterval");
  let loads = 0, changes = 0, fetches = 0;
  const preferences: FastPreferences = { load: async () => { loads++; return false; }, save: async () => {} };
  const h = harness();
  t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("must not fetch"); });
  registerFast(h.api, () => { changes++; }, preferences);
  await h.fire("session_start");
  assert.equal(loads, 1); assert.equal(intervals.mock.calls.length, 0);
  t.mock.timers.tick(60000); await settle();
  assert.equal(fetches, 0); assert.equal(changes, 0);
  for (const mode of ["rpc", "print", "json"] as const) {
    h.ctx.mode = mode; await h.fire("session_start");
    assert.equal(await h.fire("before_provider_request", { payload: { model: h.ctx.model?.id, service_tier: "priority" } }), undefined);
    await h.commands.get("fast")?.("", h.ctx);
  }
  assert.equal(loads, 1); assert.equal(intervals.mock.calls.length, 0); assert.equal(fetches, 0);
  await h.fire("session_shutdown");
});
