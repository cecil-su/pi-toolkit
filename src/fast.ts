import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Identity, officialBase, resolveIdentity } from "./auth.ts";
import { type FastPreferences, fileFastPreferences } from "./fast-preferences.ts";
import { type BoundRequest, bindFastProvider } from "./fast-provider.ts";
import { ReadThrottle, requestJson } from "./http.ts";

type Model = NonNullable<ExtensionContext["model"]>;
type ReadDirectory = (identity: Identity, signal: AbortSignal) => Promise<unknown>;
const CAPABILITY_TTL = 300_000;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid catalog");
  return value as Record<string, unknown>;
}

/** Official ModelInfo projection only; no names, model allowlist or inferred capabilities. */
export function supportsFast(payload: unknown, modelId: string, account: string): boolean {
  const root = record(payload);
  if (root.account_id !== undefined && root.account_id !== account) throw new Error("Account changed");
  if (!Array.isArray(root.models) || root.models.length > 5000) throw new Error("Invalid catalog");
  let selected: Record<string, unknown> | undefined;
  const slugs = new Set<string>();
  for (const value of root.models) {
    const row = record(value);
    if (typeof row.slug !== "string" || !row.slug || row.slug.length > 256 || slugs.has(row.slug)) throw new Error("Invalid catalog");
    slugs.add(row.slug);
    if (row.slug === modelId) selected = row;
  }
  if (!selected) return false;
  let priority = false, legacyFast = false;
  if (selected.service_tiers !== undefined) {
    if (!Array.isArray(selected.service_tiers)) throw new Error("Invalid service tiers");
    for (const value of selected.service_tiers) {
      const tier = record(value);
      if (typeof tier.id !== "string" || !tier.id) throw new Error("Invalid service tier");
      if (tier.id === "priority") priority = true;
    }
  }
  if (selected.additional_speed_tiers !== undefined) {
    if (!Array.isArray(selected.additional_speed_tiers) || selected.additional_speed_tiers.some((value) => typeof value !== "string")) {
      throw new Error("Invalid speed tiers");
    }
    legacyFast = selected.additional_speed_tiers.includes("fast");
  }
  return priority || legacyFast;
}

function eligible(model: Model | undefined): model is Model {
  return !!model && model.provider === "openai-codex" && model.api === "openai-codex-responses" && officialBase("openai-codex", model.baseUrl);
}
function selection(ctx: ExtensionContext): string {
  const model = ctx.model;
  return JSON.stringify([model?.provider, model?.api, model?.id, model?.baseUrl]);
}
const readDirectory: ReadDirectory = (identity, signal) => requestJson("codex-models", identity.headers, signal, globalThis.fetch, 8000, 2_097_152);

/** Fast preference and verified capability are deliberately separate states. */
export class FastController {
  private enabled = false;
  private loaded = false;
  private stopped = false;
  private epoch = 0;
  private modelKey = "";
  private scope?: string;
  private verifiedUntil = 0;
  private checkedAt = -Infinity;
  private capability?: { scope: string; supported: boolean; at: number };
  private pending?: { promise: Promise<void>; controller: AbortController };
  private readonly operations = new Set<AbortController>();
  private commands: Promise<void> = Promise.resolve();

  constructor(
    private readonly preferences: FastPreferences,
    private readonly changed: () => void,
    private readonly read: ReadDirectory = readDirectory,
    private readonly resolve: typeof resolveIdentity = resolveIdentity,
    private readonly now: () => number = Date.now,
    private readonly throttle: ReadThrottle = new ReadThrottle(),
  ) {}

  private notify(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info"): void {
    if (!this.stopped && ctx.hasUI) ctx.ui.notify(text, type);
  }
  async start(ctx: ExtensionContext): Promise<void> {
    try {
      const saved = await this.preferences.load();
      if (this.stopped) return;
      this.enabled = saved;
    } catch { this.notify(ctx, "Fast 偏好无法读取；保持关闭，不覆盖原文件。", "warning"); }
    if (this.stopped) return;
    this.loaded = true;
    if (this.enabled) {
      this.notify(ctx, "Fast 开启偏好已恢复：会消耗更多计划额度；仅验证当前账户/模型支持后生效。", "warning");
      void this.check(ctx);
    }
  }
  invalidate(): void {
    this.epoch++;
    for (const operation of this.operations) operation.abort();
    this.operations.clear();
    this.pending = undefined;
    this.capability = undefined;
    this.scope = undefined;
    this.verifiedUntil = 0;
    this.checkedAt = -Infinity;
  }
  stop(): void { this.stopped = true; this.invalidate(); }
  private sync(ctx: ExtensionContext): void {
    const key = selection(ctx);
    if (key !== this.modelKey) { this.invalidate(); this.modelKey = key; }
  }
  private operation(parent?: AbortSignal) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    this.operations.add(controller);
    parent?.addEventListener("abort", cancel, { once: true });
    if (parent?.aborted) cancel();
    return { controller, release: () => {
      this.operations.delete(controller);
      parent?.removeEventListener("abort", cancel);
    } };
  }
  private async identify(model: Model, ctx: ExtensionContext, signal: AbortSignal): Promise<Identity> {
    const identity = await this.resolve(model, ctx.modelRegistry, signal);
    if (identity.provider !== "openai-codex" || identity.modelId !== model.id || !identity.account ||
        (identity.expiresAt !== undefined && identity.expiresAt <= this.now())) throw new Error("Codex identity unavailable");
    return identity;
  }
  private admit(identity: Identity): void {
    if (identity.scope !== this.scope) this.capability = undefined;
    this.scope = identity.scope;
    this.verifiedUntil = Math.min(this.now() + 15_000, identity.expiresAt ?? Infinity);
  }
  effective(ctx: ExtensionContext): boolean {
    if (this.stopped || ctx.mode !== "tui") return false;
    this.sync(ctx);
    return this.enabled && eligible(ctx.model) && this.now() < this.verifiedUntil && !!this.capability?.supported &&
      this.capability.scope === this.scope && this.now() - this.capability.at < CAPABILITY_TTL;
  }

  wantsPolling(): boolean { return this.enabled && this.loaded && !this.stopped; }

  async check(ctx: ExtensionContext, force = false, allowDisabled = false): Promise<void> {
    if (this.stopped || ctx.mode !== "tui") return;
    this.sync(ctx);
    if (!this.loaded || (!this.enabled && !allowDisabled) || !eligible(ctx.model)) return;
    if (this.pending) return this.pending.promise;
    if (!force && this.now() - this.checkedAt < 10_000) return;
    this.checkedAt = this.now();
    const model = ctx.model;
    const key = selection(ctx), epoch = this.epoch;
    const operation = this.operation();
    const signal = operation.controller.signal;
    const current = () => !this.stopped && !signal.aborted && epoch === this.epoch && selection(ctx) === key;
    const task = (async () => {
      let attempted: string | undefined;
      try {
        const identity = await this.identify(model, ctx, signal);
        if (!current()) return;
        this.admit(identity);
        if (force || !this.capability || this.now() - this.capability.at >= CAPABILITY_TTL) {
          const key = identity.accountScope ?? identity.scope;
          if (!this.throttle.allowed(key, this.now())) return;
          attempted = key;
          const payload = await this.read(identity, signal);
          if (!current()) return;
          const supported = supportsFast(payload, model.id, identity.account ?? "");
          const latest = await this.identify(model, ctx, signal);
          if (!current()) return;
          if (latest.scope !== identity.scope) { this.invalidate(); return; }
          this.admit(latest);
          this.capability = { scope: identity.scope, supported, at: this.now() };
          this.throttle.success(key);
        }
      } catch (error) {
        if (current()) {
          if (attempted) this.throttle.failure(attempted, error, this.now());
          this.capability = undefined; this.verifiedUntil = 0; this.checkedAt = this.now();
        }
      } finally {
        operation.release();
        if (this.pending?.controller === operation.controller) this.pending = undefined;
        if (!this.stopped) this.changed();
      }
    })();
    this.pending = { promise: task, controller: operation.controller };
    return task;
  }

  toggle(ctx: ExtensionContext): Promise<void> {
    const task = this.commands.then(() => this.toggleOnce(ctx));
    this.commands = task.catch(() => {});
    return task;
  }
  private async toggleOnce(ctx: ExtensionContext): Promise<void> {
    if (this.stopped || !this.loaded || ctx.mode !== "tui") return;
    const next = !this.enabled;
    if (next) {
      this.notify(ctx, "开启 Codex Fast 会消耗更多计划额度；正在验证当前账户/模型支持。", "warning");
      await this.check(ctx, true, true);
      if (this.stopped) return;
      if (!eligible(ctx.model) || !this.capability?.supported || this.now() >= this.verifiedUntil) {
        this.notify(ctx, "当前官方 Codex 账户/模型的 Fast 能力未获验证；保持关闭。", "warning");
        return;
      }
    }
    try { await this.preferences.save(next); }
    catch { this.notify(ctx, "Fast 偏好保存失败；状态未改变，原文件不覆盖。", "error"); return; }
    if (this.stopped) return;
    this.enabled = next;
    if (!next) this.invalidate();
    this.notify(ctx, next ? "Fast 偏好已开启（消耗更多额度）；仅验证有效时请求 priority。" : "Fast 已关闭，后续官方 Codex 请求使用 default。");
    this.changed();
  }

  /** A payload-only hook cannot prove request identity: callers MUST bind a snapshot. */
  async apply(payload: unknown, ctx: ExtensionContext, request?: BoundRequest): Promise<unknown> {
    if (this.stopped || ctx.mode !== "tui" || !request || !eligible(request.model) ||
        !payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const identity = request.identity;
    const fast = this.enabled && "model" in payload && payload.model === request.model.id && identity &&
      identity.modelId === request.model.id && (identity.expiresAt === undefined || this.now() < identity.expiresAt) &&
      this.capability?.supported && this.capability.scope === identity.scope && this.now() - this.capability.at < CAPABILITY_TTL;
    return { ...payload, service_tier: fast ? "priority" : "default" };
  }
}

export function registerFast(pi: ExtensionAPI, changed: () => void, preferences?: FastPreferences) {
  const throttle = new ReadThrottle();
  const store = preferences ?? fileFastPreferences(() => join(getAgentDir(), "pi-toolkit.json"));
  let active: FastController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let session: ExtensionContext | undefined;
  let binding: ReturnType<typeof bindFastProvider>;
  const syncTimer = () => {
    if (active?.wantsPolling() && session?.mode === "tui") {
      if (timer === undefined) timer = setInterval(() => { if (session) void active?.check(session); }, 1000);
      timer?.unref?.();
    } else if (timer !== undefined) { clearInterval(timer); timer = undefined; }
  };
  const stop = () => {
    active?.stop(); active = undefined;
    binding?.close(); binding = undefined; session = undefined;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  pi.registerCommand("fast", {
    description: "Toggle verified Codex Fast routing (uses more plan allowance)",
    handler: async (args, ctx) => {
      if (args.trim()) { if (ctx.hasUI) ctx.ui.notify("用法：/fast（切换；开启会消耗更多额度）", "info"); return; }
      if (ctx.mode !== "tui") { if (ctx.hasUI) ctx.ui.notify("Fast 仅用于交互 TUI；此模式不改请求。", "warning"); return; }
      if (!binding?.owned() && !active?.wantsPolling()) { ctx.ui.notify?.("Fast 请求适配器不可用或存在 provider 接管冲突；未开启。", "warning"); return; }
      await active?.toggle(ctx);
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui") return;
    session = ctx;
    const controller = new FastController(store, () => { syncTimer(); changed(); }, undefined, undefined, Date.now, throttle);
    binding = bindFastProvider(pi, ctx, (payload, request) => controller.apply(payload, ctx, request));
    if (!binding) { ctx.ui.notify?.("Fast 请求适配器不可用或已有 provider 接管；保持关闭。", "warning"); return; }
    active = controller;
    await controller.start(ctx);
    if (active === controller) syncTimer();
  });
  pi.on("session_shutdown", stop);
  pi.on("model_select", (_event, ctx) => { active?.invalidate(); void active?.check(ctx); changed(); });
  return { effective: (ctx: ExtensionContext) => binding?.owned() ? active?.effective(ctx) ?? false : false };
}
