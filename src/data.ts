export type SupportedProvider = "openai-codex" | "deepseek";

export interface QuotaWindow {
  remaining: number;
  resetsAt?: number; // Unix milliseconds; never inferred from a window's duration.
}

export type Usage =
  | { provider: "openai-codex"; fiveHour?: QuotaWindow; sevenDay?: QuotaWindow }
  | { provider: "deepseek"; available: boolean; balances: { currency: "CNY" | "USD"; amount: string }[] };

export type UsageView =
  | { status: "ready"; usage: Usage }
  | { status: "loading" | "unavailable" | "stale" | "unsupported" };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid usage response");
  return value as Record<string, unknown>;
}

function window(value: unknown): { seconds: number; quota: QuotaWindow } | undefined {
  if (value == null) return undefined;
  const row = object(value);
  const used = row.used_percent;
  const seconds = row.limit_window_seconds;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100 ||
      typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error("Invalid usage window");
  }
  let resetsAt: number | undefined;
  if (row.reset_at != null) {
    if (typeof row.reset_at !== "number" || !Number.isSafeInteger(row.reset_at) ||
        row.reset_at <= 0 || row.reset_at > 8_640_000_000_000) throw new Error("Invalid reset time");
    resetsAt = row.reset_at * 1000;
  }
  return { seconds, quota: { remaining: 100 - used, resetsAt } };
}

/** Root windows are account allowances, not model-specific additional buckets. */
export function parseCodex(payload: unknown, account: string): Usage {
  const root = object(payload);
  if (root.account_id != null && root.account_id !== account) throw new Error("Account changed");
  // Additional buckets can coexist with these account windows. Their opaque feature
  // names are not a model-ID protocol; do not substitute, merge or guess their scope.
  const rate = object(root.rate_limit);
  const result: Extract<Usage, { provider: "openai-codex" }> = { provider: "openai-codex" };
  for (const raw of [rate.primary_window, rate.secondary_window]) {
    const parsed = window(raw);
    if (!parsed) continue;
    const key = parsed.seconds === 18_000 ? "fiveHour" : parsed.seconds === 604_800 ? "sevenDay" : undefined;
    if (!key) continue; // Do not relabel an unknown duration as 5h or 7d.
    if (result[key]) throw new Error("Duplicate usage window");
    result[key] = parsed.quota;
  }
  if (!result.fiveHour && !result.sevenDay) throw new Error("Usage windows unavailable");
  return result;
}

export function parseDeepSeek(payload: unknown): Usage {
  const root = object(payload);
  if (typeof root.is_available !== "boolean" || !Array.isArray(root.balance_infos) ||
      root.balance_infos.length < 1 || root.balance_infos.length > 2) throw new Error("Invalid balance response");
  const seen = new Set<string>();
  const balances = root.balance_infos.map<{ currency: "CNY" | "USD"; amount: string }>((value) => {
    const row = object(value);
    const currency = row.currency;
    const amount = row.total_balance;
    if ((currency !== "CNY" && currency !== "USD") || seen.has(currency) ||
        typeof amount !== "string" || amount.length > 512 || !/^-?\d+(?:\.\d+)?$/.test(amount)) {
      throw new Error("Invalid currency balance");
    }
    seen.add(currency);
    return { currency, amount };
  });
  return { provider: "deepseek", available: root.is_available, balances };
}
