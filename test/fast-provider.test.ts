import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { InMemoryCredentialStore, InMemoryModelsStore, type StreamOptions } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { FastController } from "../src/fast.ts";
import { bindFastProvider } from "../src/fast-provider.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

test("real Pi1.3 ModelRuntime: actual auth/endpoint, concurrent same-ID requests, full/simple parity, hook and registration restoration", async () => {
  const credentials = new InMemoryCredentialStore();
  const expires = Date.now() + 3600000;
  const credential = (account: string) => ({ type: "oauth" as const, refresh: "synthetic", expires,
    access: `synthetic.${Buffer.from(JSON.stringify({ sub: "synthetic-user", exp: Math.floor(expires / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.synthetic` });
  await credentials.modify("openai-codex", async () => credential("B"));
  const seed = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
  const slug = seed.getModels("openai-codex")[0].id;
  const dir = await mkdtemp(join(tmpdir(), "fast-provider-")); const modelsPath = join(dir, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { "openai-codex": { modelOverrides: {
    [slug]: { name: "Synthetic overridden name", contextWindow: 1050000, headers: { "X-Synthetic": "kept" } },
  } } } }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
  // Do not inspect ambient providers/credentials during automatic registration refresh.
  runtime.refresh = async () => ({ aborted: false, errors: new Map() });
  const privateAvailability = runtime as unknown as { refreshProviderAvailability(id: string, signal: AbortSignal): Promise<void> };
  await privateAvailability.refreshProviderAvailability("openai-codex", new AbortController().signal);
  const registry = new ModelRegistry(runtime); const model = runtime.getModel("openai-codex", slug);
  assert.ok(model); assert.equal(model.contextWindow, 1050000);
  const ctx = { mode: "tui", hasUI: false, model, modelRegistry: registry } as unknown as ExtensionContext;
  const pi = { registerProvider(id: string, config: ProviderConfig) { registry.registerProvider(id, config); }, unregisterProvider(id: string) { registry.unregisterProvider(id); } } as unknown as ExtensionAPI;
  const fast = new FastController({ load: async () => false, save: async () => {} }, () => {}, async (identity) => {
    assert.equal(identity.account, "B"); // A has never had a supported catalog.
    return { models: [{ slug, service_tiers: [{ id: "priority" }] }] };
  });
  await fast.start(ctx); await fast.toggle(ctx); assert.equal(fast.effective(ctx), true);
  const originalModels = registry.getAll();
  const captured: { url: string; account: string | null; body: Record<string, unknown> }[] = [];
  let responses = 0, hooks = 0;
  const fetcher: typeof fetch = async (url, options) => {
    const headers = new Headers(options?.headers);
    const raw = headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(options?.body as Uint8Array).toString() : String(options?.body);
    captured.push({ url: String(url), account: headers.get("chatgpt-account-id"), body: JSON.parse(raw) });
    assert.equal(headers.get("x-synthetic"), "kept");
    return new Response("synthetic rejection", { status: 400 });
  };
  const transcript = { messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "synthetic probe" }], timestamp: 0 }] };
  const options = { apiKey: credential("B").access, transport: "sse" as const, maxRetries: 0, fetch: fetcher,
    textVerbosity: "high" as const, reasoningEffort: "none" as const, temperature: 0.7, toolChoice: "none" as const,
    onResponse() { responses++; }, onProviderStreamEvent() {},
    onPayload(payload: unknown) { hooks++; return { ...(payload as object), synthetic_marker: "kept" }; },
  };
  // Baseline is stock full-stream, not a mock provider implementation.
  await runtime.stream(model, transcript, options).result(); const baseline = captured.pop(); assert.ok(baseline);
  const binding = bindFastProvider(pi, ctx, (body, request) => fast.apply(body, ctx, request)); assert.ok(binding);
  assert.deepEqual(registry.getAll(), originalModels);
  await runtime.stream(model, transcript, options).result(); const full = captured.pop(); assert.ok(full);
  const { service_tier: _tier, ...rest } = full.body;
  assert.deepEqual(rest, baseline.body); assert.equal(full.body.service_tier, "priority");
  await runtime.streamSimple(model, transcript, { ...options, reasoning: "high" }).result();
  assert.equal(captured.pop()?.body.service_tier, "priority");
  // Same captured-auth race as both preserved review scripts, using real prepareRequest.
  await credentials.modify("openai-codex", async () => credential("A"));
  await runtime.streamSimple(model, transcript, { transport: "sse", maxRetries: 0, fetch: fetcher,
    transformHeaders: async (headers) => { await credentials.modify("openai-codex", async () => credential("B")); return headers; },
  }).result();
  const raced = captured.pop(); assert.equal(raced?.account, "A"); assert.equal(raced?.body.service_tier, "default");
  await runtime.streamSimple({ ...model, baseUrl: "https://synthetic-proxy.example/backend-api" }, transcript,
    { ...options, serviceTier: "flex" } as StreamOptions).result();
  const custom = captured.pop(); assert.match(custom?.url ?? "", /synthetic-proxy/); assert.equal(custom?.body.service_tier, "flex");
  // A waits inside an earlier hook while B is sent; no lastHeaders/shared snapshot.
  const entered = deferred(), release = deferred();
  const a = runtime.stream(model, transcript, { ...options, apiKey: credential("A").access,
    onPayload: async (body) => { entered.resolve(); await release.promise; return body; },
  }).result();
  await entered.promise;
  await runtime.stream(model, transcript, options).result(); release.resolve(); await a;
  const concurrent = captured.splice(0);
  assert.equal(concurrent.find((entry) => entry.account === "A")?.body.service_tier, "default");
  assert.equal(concurrent.find((entry) => entry.account === "B")?.body.service_tier, "priority");
  assert.ok(hooks >= 4); assert.ok(responses >= 6);
  binding.close(); assert.equal(registry.getRegisteredProviderConfig("openai-codex"), undefined);
  assert.deepEqual(registry.getAll(), originalModels);
  // Repeated reload-like cycles leave only one adapter and restore the original registration.
  for (let i = 0; i < 3; i++) {
    const next = bindFastProvider(pi, ctx, (body, request) => fast.apply(body, ctx, request)); assert.ok(next);
    assert.equal(bindFastProvider(pi, ctx, async () => undefined), undefined); next.close();
  }
  const merged = bindFastProvider(pi, ctx, (body, request) => fast.apply(body, ctx, request)); assert.ok(merged);
  pi.registerProvider("openai-codex", { baseUrl: "https://synthetic-proxy.example" }); merged.close();
  assert.equal(registry.getRegisteredProviderConfig("openai-codex")?.baseUrl, "https://synthetic-proxy.example");
  assert.equal(registry.getRegisteredProviderConfig("openai-codex")?.streamSimple, undefined);
  fast.stop();
});
