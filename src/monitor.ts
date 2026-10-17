import type { Identity } from "./auth.ts";
import { parseCodex, parseDeepSeek, type Usage, type UsageView } from "./data.ts";
import { ReadThrottle, requestJson } from "./http.ts";

export type ResolveIdentity = (signal: AbortSignal) => Promise<Identity | undefined>;
export type ReadUsage = (identity: Identity, signal: AbortSignal) => Promise<unknown>;

export async function readUsage(identity: Identity, signal: AbortSignal): Promise<unknown> {
  return requestJson(identity.provider, identity.headers, signal);
}

/** One in-memory slot, never a cross-account/model cache. No secrets are persisted. */
export class UsageMonitor {
  private epoch = 0;
  private stopped = false;
  private probe?: AbortController;
  private request?: AbortController;
  private scope?: string;
  private verifiedAt = -Infinity;
  private authExpiresAt = Infinity;
  private snapshot?: { usage: Usage; at: number };
  private status: "loading" | "unavailable" | "unsupported" = "loading";
  private lastAttempt = -Infinity;
  private lastProbeAt = -Infinity;

  constructor(
    private readonly resolve: ResolveIdentity,
    private readonly changed: () => void,
    private readonly read: ReadUsage = readUsage,
    private readonly now: () => number = Date.now,
    private readonly throttle: ReadThrottle = new ReadThrottle(60_000),
  ) {}

  view(): UsageView {
    if (this.snapshot) {
      if (this.now() - this.verifiedAt >= 15_000 || this.now() >= this.authExpiresAt ||
          this.now() - this.snapshot.at >= 90_000) return { status: "stale" };
      return { status: "ready", usage: this.snapshot.usage };
    }
    return { status: this.status };
  }

  /** Called on every observed model change, reload and session replacement. */
  invalidate(): void {
    this.epoch++;
    this.probe?.abort();
    this.request?.abort();
    this.probe = this.request = undefined;
    this.scope = undefined;
    this.snapshot = undefined;
    this.verifiedAt = -Infinity;
    this.authExpiresAt = Infinity;
    this.status = "loading";
    this.lastAttempt = -Infinity;
    this.lastProbeAt = -Infinity;
  }

  stop(): void {
    if (this.stopped) return;
    this.invalidate();
    this.stopped = true;
  }

  /** Scheduling runs every second, but auth resolves only every 10s or on an event.
   * A 15s identity lease prevents indefinite display if credential resolution stalls.
   */
  async poll(force = false): Promise<void> {
    if (this.stopped || this.probe || (!force && this.now() - this.lastProbeAt < 10_000)) return;
    this.lastProbeAt = this.now();
    const probe = new AbortController();
    this.probe = probe;
    const epoch = this.epoch;
    try {
      const identity = await this.resolve(probe.signal);
      if (this.stopped || probe.signal.aborted || epoch !== this.epoch) return;
      if (!identity) {
        this.invalidate();
        this.status = "unsupported";
        this.lastProbeAt = this.now();
        return;
      }
      if (identity.scope !== this.scope) {
        this.request?.abort();
        this.request = undefined;
        this.snapshot = undefined;
        this.scope = identity.scope;
        this.lastAttempt = -Infinity;
        this.status = "loading";
      }
      this.verifiedAt = this.now();
      this.authExpiresAt = identity.expiresAt ?? Infinity;
      const allowed = this.throttle.allowed(identity.accountScope ?? identity.scope, this.now());
      if (!allowed && !this.snapshot && !this.request) this.status = "unavailable";
      if (!this.request && this.now() - this.lastAttempt >= 60_000 && allowed) {
        const request = new AbortController();
        this.request = request;
        this.lastAttempt = this.now();
        void this.fetch(identity, request, epoch);
      }
    } catch {
      if (!this.stopped && !probe.signal.aborted && epoch === this.epoch) {
        this.invalidate();
        this.status = "unavailable";
        this.lastProbeAt = this.now();
      }
    } finally {
      if (this.probe === probe) this.probe = undefined;
      if (!this.stopped) this.changed();
    }
  }

  private async fetch(identity: Identity, request: AbortController, epoch: number): Promise<void> {
    const current = () => !this.stopped && !request.signal.aborted && epoch === this.epoch && this.request === request;
    try {
      const payload = await this.read(identity, request.signal);
      if (!current()) return;
      if (identity.provider === "openai-codex" && !identity.account) throw new Error("Account unavailable");
      const usage = identity.provider === "openai-codex"
        ? parseCodex(payload, identity.account ?? "") : parseDeepSeek(payload);
      // A login/logout can occur while the HTTP request is in flight.
      const latest = await this.resolve(request.signal);
      if (!current()) return;
      if (!latest || latest.scope !== identity.scope) {
        this.invalidate();
        return;
      }
      this.snapshot = { usage, at: this.now() };
      this.verifiedAt = this.now();
      this.authExpiresAt = latest.expiresAt ?? Infinity;
      this.lastProbeAt = this.now();
      this.throttle.success(identity.accountScope ?? identity.scope);
    } catch (error) {
      if (current()) {
        this.throttle.failure(identity.accountScope ?? identity.scope, error, this.now());
        this.snapshot = undefined; // Failure is not zero, full, or an old successful value.
        this.status = "unavailable";
      }
    } finally {
      if (this.request === request) this.request = undefined;
      if (!this.stopped) this.changed();
    }
  }
}
