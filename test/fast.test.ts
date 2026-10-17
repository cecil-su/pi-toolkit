import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay, setImmediate as settle } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Identity } from "../src/auth.ts";
import { FastController, supportsFast } from "../src/fast.ts";
import { fileFastPreferences } from "../src/fast-preferences.ts";
import { ENDPOINTS, ReadFailure, requestJson } from "../src/http.ts";

const catalog = (slug = "runtime-model") => ({ models: [{ slug, service_tiers: [{ id: "priority" }] }] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function fixture(saved = false) {
  const messages: string[] = [], writes: boolean[] = [];
  const ctx = { mode: "tui", hasUI: true, model: { provider: "openai-codex", api: "openai-codex-responses", id: "runtime-model", baseUrl: "https://chatgpt.com/backend-api" },
    modelRegistry: {}, ui: { notify(text: string) { messages.push(text); } } } as unknown as ExtensionContext;
  let time = 0, reads = 0, auths = 0, changes = 0, failSave = false;
  let identity: Identity = { provider: "openai-codex", modelId: "runtime-model", account: "A", scope: "A", headers: {} };
  let failure: unknown, waiting: ReturnType<typeof deferred<unknown>> | undefined, saving: ReturnType<typeof deferred<void>> | undefined;
  const signals: AbortSignal[] = [];
  const controller = new FastController({ load: async () => saved, save: async (value) => {
    if (saving) await saving.promise;
    if (failSave) throw new Error("private save error");
    saved = value; writes.push(value);
  } }, () => { changes++; }, async (_id, signal) => {
    reads++; signals.push(signal); if (failure) throw failure; return waiting ? waiting.promise : catalog(ctx.model?.id);
  }, async (_m, _r, signal) => { auths++; signals.push(signal); return identity; }, () => time);
  return { controller, ctx, writes, messages, signals, stats: () => ({ reads, auths, changes }),
    time(value: number) { time = value; }, account(value: Identity) { identity = value; },
    failSave(value: boolean) { failSave = value; }, failRead(value: unknown) { failure = value; }, waitRead(value: typeof waiting) { waiting = value; }, waitSave(value: typeof saving) { saving = value; },
    apply(body: unknown, actual = ctx.model, actualIdentity = identity) {
      assert.ok(actual); return controller.apply(body, ctx, { model: actual, identity: actualIdentity });
    },
  };
}
const payload = () => ({ model: "runtime-model", reasoning: { effort: "off" }, input: [], service_tier: "priority" });

test("directory requires exact slug and explicit official priority or legacy fast fields", () => {
  assert.equal(supportsFast(catalog(), "runtime-model", "a"), true);
  assert.equal(supportsFast({ models: [{ slug: "runtime-model", additional_speed_tiers: ["fast"] }] }, "runtime-model", "a"), true);
  for (const row of [{ slug: "runtime-model" }, { slug: "runtime-model", service_tiers: [] }, { slug: "runtime-model", service_tiers: [{ id: "fast" }] },
    { slug: "runtime-model", additional_speed_tiers: ["priority"] }, { slug: "other", service_tiers: [{ id: "priority" }] }]) assert.equal(supportsFast({ models: [row] }, "runtime-model", "a"), false);
  for (const bad of [null, { models: {} }, { models: [null] }, { models: [{ id: "runtime-model" }] }, { models: [catalog().models[0], catalog().models[0]] },
    { models: [{ slug: "runtime-model", service_tiers: ["priority"] }] }, { models: [{ slug: "runtime-model", additional_speed_tiers: "fast" }] }, { account_id: "other", ...catalog() }]) {
    assert.throws(() => supportsFast(bad, "runtime-model", "a"));
  }
});

test("default off; snapshot required; explicit toggle warns/saves and leaves model/thinking/input unchanged", async () => {
  const f = fixture(); await f.controller.start(f.ctx);
  assert.equal(f.controller.wantsPolling(), false); assert.equal(f.stats().reads, 0);
  assert.equal(await f.controller.apply(payload(), f.ctx), undefined); // Old unsafe payload-only API is inert.
  const input = payload(); assert.equal((await f.apply(input) as typeof input).service_tier, "default");
  const model = f.ctx.model;
  await f.controller.toggle(f.ctx);
  assert.deepEqual(f.writes, [true]); assert.equal(f.controller.effective(f.ctx), true);
  assert.ok(f.messages.some((text) => text.includes("更多计划额度")));
  assert.equal((await f.apply(input) as typeof input).service_tier, "priority");
  assert.equal(input.service_tier, "priority"); assert.equal(f.ctx.model, model);
  await f.controller.toggle(f.ctx);
  assert.equal((await f.apply(input) as typeof input).service_tier, "default"); assert.equal(f.controller.wantsPolling(), false);
  f.controller.stop();
});

test("bound request identity, not current registry/model, controls Fast; other targets stay untouched", async () => {
  const f = fixture(); await f.controller.start(f.ctx); await f.controller.toggle(f.ctx);
  const snapshot = { provider: "openai-codex" as const, modelId: "runtime-model", account: "A", scope: "A", headers: {} };
  f.account({ ...snapshot, account: "B", scope: "B" });
  assert.equal((await f.apply(payload()) as { service_tier: string }).service_tier, "default");
  assert.equal((await f.apply(payload(), f.ctx.model, snapshot) as { service_tier: string }).service_tier, "priority");
  assert.ok(f.ctx.model);
  assert.equal(await f.apply(payload(), { ...f.ctx.model, baseUrl: "https://proxy.example" }), undefined);
  f.ctx.mode = "rpc"; assert.equal(await f.apply(payload()), undefined);
  f.controller.stop();
});

test("save failure does not apply; off/on saves serialize; late save cannot enable a stopped session", async () => {
  const f = fixture(); await f.controller.start(f.ctx);
  f.failSave(true); await f.controller.toggle(f.ctx); assert.deepEqual(f.writes, []); assert.equal(f.controller.effective(f.ctx), false);
  f.failSave(false); await f.controller.toggle(f.ctx);
  f.failSave(true); await f.controller.toggle(f.ctx); assert.equal(f.controller.effective(f.ctx), true);
  f.failSave(false); const wait = deferred<void>(); f.waitSave(wait);
  const off = f.controller.toggle(f.ctx); await settle(); const on = f.controller.toggle(f.ctx);
  wait.resolve(); await off; await on; assert.deepEqual(f.writes, [true, false, true]);
  const late = deferred<void>(); f.waitSave(late); const last = f.controller.toggle(f.ctx); await settle();
  f.controller.stop(); const count = f.messages.length; late.resolve(); await last;
  assert.equal(f.controller.effective(f.ctx), false); assert.equal(f.messages.length, count);
});

test("restore/failed directory/unknown capability never claim Fast, deadlines block force, success recovers", async () => {
  const f = fixture(true); const pending = deferred<unknown>(); f.waitRead(pending);
  await f.controller.start(f.ctx); assert.equal(f.controller.effective(f.ctx), false);
  assert.equal((await f.apply(payload()) as { service_tier: string }).service_tier, "default");
  pending.resolve({ models: [{ slug: "runtime-model" }] }); await settle();
  assert.equal(f.controller.effective(f.ctx), false);
  f.waitRead(undefined); await f.controller.check(f.ctx, true); assert.equal(f.controller.effective(f.ctx), true);
  f.failRead(new ReadFailure("http", 429, 3_600_000)); await f.controller.check(f.ctx, true);
  assert.equal(f.controller.effective(f.ctx), false);
  const before = f.stats().reads; f.time(1_000_000); f.failRead(undefined);
  await f.controller.check(f.ctx, true); assert.equal(f.stats().reads, before);
  assert.equal((await f.apply(payload()) as { service_tier: string }).service_tier, "default");
  f.time(3_600_000); await f.controller.check(f.ctx, true); assert.equal(f.controller.effective(f.ctx), true);
  f.controller.stop();
});

test("expiry/close/model invalidation and late results cannot reactivate Fast", async () => {
  const f = fixture(); await f.controller.start(f.ctx); await f.controller.toggle(f.ctx);
  f.time(15000); assert.equal(f.controller.effective(f.ctx), false);
  await f.controller.check(f.ctx); assert.equal(f.controller.effective(f.ctx), true);
  f.time(300000); assert.equal((await f.apply(payload()) as { service_tier: string }).service_tier, "default");
  const pending = deferred<unknown>(); f.waitRead(pending); const check = f.controller.check(f.ctx, true); await settle();
  await f.controller.toggle(f.ctx); assert.ok(f.signals.some((s) => s.aborted));
  pending.resolve(catalog()); await check; assert.equal(f.controller.effective(f.ctx), false);
  f.controller.stop();
});

test("directory identity/model changes and late preference load never admit stale capability", async () => {
  const f = fixture(true); const pending = deferred<unknown>(); f.waitRead(pending);
  await f.controller.start(f.ctx); await settle();
  const check = f.controller.check(f.ctx, true);
  f.account({ provider: "openai-codex", modelId: "runtime-model", account: "B", scope: "B", headers: {} });
  pending.resolve(catalog()); await check;
  assert.equal(f.controller.effective(f.ctx), false);
  assert.equal((await f.apply(payload()) as { service_tier: string }).service_tier, "default");
  f.controller.stop();
  const loaded = deferred<boolean>(); let reads = 0;
  const controller = new FastController({ load: () => loaded.promise, save: async () => {} }, () => {}, async () => { reads++; return catalog(); });
  const start = controller.start(f.ctx); controller.stop(); loaded.resolve(true); await start;
  assert.equal(reads, 0); assert.equal(controller.effective(f.ctx), false);
});

test("own file persists only a boolean, rejects malformed/oversized files and preserves them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fast-preferences-")); const file = join(dir, "pi-toolkit.json");
  const store = fileFastPreferences(() => file); assert.equal(await store.load(), false);
  await store.save(true); assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { fast: true });
  await store.save(false); assert.equal(await store.load(), false);
  for (const value of ["broken", "{}", '{"fast":"true"}', '{"fast":true,"other":false}', "x".repeat(1025)]) {
    await writeFile(file, value); await assert.rejects(store.load()); await assert.rejects(store.save(true)); assert.equal(await readFile(file, "utf8"), value);
  }
  const folder = join(dir, "folder"); await mkdir(folder); await assert.rejects(fileFastPreferences(() => folder).save(true));
});

test("directory uses bounded fixed GET, current request headers, no redirect; timeout cancels", async () => {
  const headers = { Authorization: "Bearer synthetic", "chatgpt-account-id": "synthetic" }; const signal = new AbortController().signal;
  const result = await requestJson("codex-models", headers, signal, async (url, options) => {
    assert.equal(url, ENDPOINTS["codex-models"]); assert.equal(options?.method, "GET"); assert.equal(options?.redirect, "error");
    assert.deepEqual(options?.headers, { Accept: "application/json", ...headers }); return new Response(JSON.stringify(catalog()));
  });
  assert.equal(supportsFast(result, "runtime-model", "synthetic"), true);
  await assert.rejects(requestJson("codex-models", headers, signal, async () => new Response("{}", { headers: { "content-length": "2097153" } }), 8000, 2097152));
  let received: AbortSignal | null | undefined;
  await Promise.all([assert.rejects(requestJson("codex-models", headers, signal, async (_u, options) => { received = options?.signal; return new Promise(() => {}); }, 5)), delay(20)]);
  assert.equal(received?.aborted, true);
});
