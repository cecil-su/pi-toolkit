import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Identity } from "../src/auth.ts";
import { FastController } from "../src/fast.ts";
import { ReadFailure, ReadThrottle, requestJson, retryAfter } from "../src/http.ts";
import { UsageMonitor } from "../src/monitor.ts";

const id = (account = "A", modelId = "M"): Identity => ({ provider: "openai-codex", modelId, account, accountScope: account, scope: `${account}:${modelId}`, headers: {} });
const usage = { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } } };

test("HTTP exposes only safe status/kind/deadline; Retry-After supports seconds/date and ignores invalid/past values", async () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  assert.equal(retryAfter("120", now), now + 120000);
  assert.equal(retryAfter(new Date(now + 60000).toUTCString(), now), now + 60000);
  for (const value of [null, "-1", "nonsense secret", "Infinity", "0", "9".repeat(128), new Date(now - 1000).toUTCString()]) assert.equal(retryAfter(value, now), undefined);
  for (const status of [429, 503]) {
    await assert.rejects(requestJson("codex-models", {}, new AbortController().signal,
      async () => new Response("PRIVATE payload", { status, headers: { "Retry-After": "120", Authorization: "PRIVATE token" } }), 8000, 1024, () => now),
    (error: unknown) => {
      assert.ok(error instanceof ReadFailure); assert.equal(error.kind, "http"); assert.equal(error.status, status); assert.equal(error.retryAt, now + 120000);
      assert.ok(!JSON.stringify(error).includes("PRIVATE")); assert.equal(error.message, "Usage unavailable"); return true;
    });
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(requestJson("deepseek", {}, abort.signal), (error: unknown) => error instanceof ReadFailure && error.kind === "cancelled");
});

test("backoff grows to cap, respects server deadline without capping it, cancel preserves deadline and success resets", () => {
  const gate = new ReadThrottle(1000, 4000);
  gate.failure("A", new ReadFailure("network"), 0);
  assert.equal(gate.allowed("A", 999), false); assert.equal(gate.allowed("B", 0), true);
  gate.failure("A", new ReadFailure("http", 503), 1000);
  assert.equal(gate.allowed("A", 2999), false);
  gate.failure("A", new ReadFailure("http", 429, 100000), 3000);
  gate.failure("A", new ReadFailure("cancelled"), 4000);
  assert.equal(gate.allowed("A", 99999), false); assert.equal(gate.allowed("A", 100000), true);
  gate.success("A"); gate.failure("A", new ReadFailure("timeout"), 100000);
  assert.equal(gate.allowed("A", 101000), true);
  for (let i = 0; i < 35; i++) gate.failure("C", new ReadFailure("network"), 0);
  assert.equal(gate.allowed("C", 3999), false); assert.equal(gate.allowed("C", 4000), true);
});

test("UsageMonitor force/model/account switches cannot bypass Retry-After; failure backoff recovers/reset", async () => {
  let now = 0, current = id(), fail: unknown = new ReadFailure("http", 429, 3600000);
  const reads: string[] = [];
  const monitor = new UsageMonitor(async () => current, () => {}, async (identity) => {
    reads.push(identity.accountScope ?? identity.scope); if (identity.account === "A" && fail) throw fail; return usage;
  }, () => now);
  await monitor.poll(); await settle(); assert.equal(monitor.view().status, "unavailable");
  for (now = 10000; now <= 50000; now += 10000) { await monitor.poll(true); await settle(); }
  assert.deepEqual(reads, ["A"]);
  monitor.invalidate(); current = id("A", "other-model"); await monitor.poll(true); await settle(); assert.equal(reads.length, 1);
  assert.equal(monitor.view().status, "unavailable"); // No GET is running during the preserved one-hour deadline.
  monitor.invalidate(); current = id("B"); await monitor.poll(true); await settle(); assert.deepEqual(reads, ["A", "B"]);
  monitor.invalidate(); current = id(); now = 3599999; await monitor.poll(true); await settle(); assert.equal(reads.length, 2);
  now = 3600000; fail = new ReadFailure("network"); await monitor.poll(true); await settle(); assert.equal(reads.length, 3);
  now = 3660000; await monitor.poll(true); await settle(); assert.equal(reads.length, 3);
  now = 3720000; fail = undefined; await monitor.poll(true); await settle(); assert.equal(monitor.view().status, "ready");
  now += 60000; fail = new ReadFailure("http", 503); await monitor.poll(true); await settle();
  const before = reads.length; now += 60000; await monitor.poll(true); await settle(); assert.equal(reads.length, before + 1);
  monitor.stop();
});

test("Fast force/commands respect Retry-After across same-account models; account isolation, failure and recovery", async () => {
  let now = 0, current = id(), fail: unknown = new ReadFailure("http", 503, 120000);
  const ctx = { mode: "tui", hasUI: false, model: { provider: "openai-codex", api: "openai-codex-responses", id: "M", baseUrl: "https://chatgpt.com/backend-api" }, modelRegistry: {} } as unknown as ExtensionContext;
  const reads: string[] = [];
  const fast = new FastController({ load: async () => true, save: async () => {} }, () => {}, async (identity) => {
    reads.push(identity.accountScope ?? identity.scope); if (identity.account === "A" && fail) throw fail;
    return { models: [{ slug: identity.modelId, service_tiers: [{ id: "priority" }] }] };
  }, async () => current, () => now);
  await fast.start(ctx); await fast.check(ctx); assert.equal(fast.effective(ctx), false);
  for (now = 10000; now <= 50000; now += 10000) await fast.check(ctx, true);
  assert.deepEqual(reads, ["A"]);
  assert.ok(ctx.model); ctx.model = { ...ctx.model, id: "N" }; current = id("A", "N"); fast.invalidate(); await fast.check(ctx, true); assert.equal(reads.length, 1);
  current = id("B", "N"); await fast.check(ctx, true); assert.equal(fast.effective(ctx), true);
  current = id("A", "N"); fast.invalidate(); now = 119999; await fast.check(ctx, true); assert.equal(fast.effective(ctx), false); assert.equal(reads.length, 2);
  now = 120000; fail = undefined; await fast.check(ctx, true); assert.equal(fast.effective(ctx), true);
  fail = new ReadFailure("cancelled"); await fast.check(ctx, true); fail = undefined;
  await fast.check(ctx, true); assert.equal(fast.effective(ctx), true); // cancellation adds no delay.
  fast.stop();
});
