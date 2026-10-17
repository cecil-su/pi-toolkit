import type { ContextUsage, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, rgbColor, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { QuotaWindow, UsageView } from "./data.ts";

type BarPaint = (body: string) => string;
const unpainted: BarPaint = (body) => body;

/** Concrete colors let Theme handle terminal-default tokens and ANSI256 conversion. */
export function paintBar(body: string, theme: Pick<Theme, "appearance" | "style"> & { colors: Pick<Theme["colors"], "accent"> }): string {
  const accent = theme.colors.accent;
  const light = theme.appearance === "light";
  return theme.style(body, {
    fg: mixColors(accent, rgbColor(255, 255, 255), light ? 0.8 : 0.65, "srgb"),
    bg: mixColors(accent, rgbColor(0, 0, 0), light ? 0.65 : 0.8, "srgb"),
  });
}

export function cleanLabel(text: string): string {
  return stripTerminalSequences(text).replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ").trim();
}

export function percent(value: number): string {
  const bounded = Math.max(0, Math.min(100, value));
  if (bounded > 0 && bounded < 0.01) return "<0.01%";
  if (bounded < 100 && bounded > 99.99) return ">99.99%";
  return `${Number(bounded.toFixed(2))}%`;
}

/** Nearest 1/8-cell; both this bar and percent() receive the same remaining value. */
export function bar(remaining: number, cells = 10): string {
  const count = Math.max(1, Math.floor(cells));
  const units = Math.round(Math.max(0, Math.min(100, remaining)) / 100 * count * 8);
  const whole = Math.floor(units / 8);
  const fraction = units % 8;
  return "█".repeat(whole) + (fraction ? "▏▎▍▌▋▊▉"[fraction - 1] : "") + " ".repeat(count - whole - (fraction ? 1 : 0));
}

function knownWindow(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function formatContextWindow(value?: number): string {
  if (!knownWindow(value)) return "?";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`;
  if (value >= 1000) return `${Number((value / 1000).toFixed(2))}k`;
  return String(value);
}

export function contextLeft(usage?: ContextUsage, modelContextWindow?: number): string {
  const window = knownWindow(usage?.contextWindow) ? usage.contextWindow : modelContextWindow;
  let remaining = "?";
  if (knownWindow(window) && usage && usage.tokens !== null && usage.percent !== null &&
      Number.isFinite(usage.tokens) && Number.isFinite(usage.percent) && usage.tokens >= 0 && usage.percent >= 0) {
    remaining = percent(100 - usage.percent);
  }
  return `ctx ${remaining}/${formatContextWindow(window)}`;
}

export function countdown(reset: number | undefined, now: number): string {
  if (reset === undefined || !Number.isFinite(reset)) return "~?";
  const diff = reset - now;
  if (diff <= 0) return "reset due";
  if (diff < 60_000) return "~<1m";
  const minutes = Math.floor(diff / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  if (days) return `~${days}d${hours}h`;
  if (hours) return `~${hours}h${mins}m`;
  return `~${mins}m`;
}

function quota(label: string, window: QuotaWindow, now: number, width: number, paint: BarPaint): string {
  if (window.resetsAt !== undefined && window.resetsAt <= now) return `${label} reset due`;
  let cells = 10;
  const field = (paint: BarPaint) => `${label} [${paint(bar(window.remaining, cells))}] ${percent(window.remaining)} ${countdown(window.resetsAt, now)}`;
  while (cells > 2 && visibleWidth(field(unpainted)) > width) cells--;
  return field(paint);
}

function pack(fields: string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const field of fields) {
    if (visibleWidth(field) > width) {
      if (line) { lines.push(line); line = ""; }
      // Styled quota fields are ASCII: column slicing preserves every track space,
      // unlike word wrapping which trims blanks. Each continuation inherits its ANSI
      // state from the original field, then closes it before the terminal's next row.
      if (field.includes("\x1b")) {
        for (let column = 0; column < visibleWidth(field); column += width) {
          lines.push(`${sliceByColumn(field, column, width, true)}\x1b[0m`);
        }
      } else {
        lines.push(...wrapTextWithAnsi(field, width).map((part) => truncateToWidth(part, width, "")));
      }
    } else if (!line) line = field;
    else if (visibleWidth(`${line} | ${field}`) <= width) line += ` | ${field}`;
    else { lines.push(line); line = field; }
  }
  if (line) lines.push(line);
  return lines;
}

export interface FooterState {
  modelName?: string;
  thinkingLevel?: ExtensionContext["thinkingLevel"];
  provider?: string;
  context?: ContextUsage;
  modelContextWindow?: number;
  branch?: string | null;
  view: UsageView;
  now: number;
}

export function renderFooter(state: FooterState, width: number, paint: BarPaint = unpainted): string[] {
  width = Math.max(0, Math.floor(width));
  if (!width) return [];
  const clippedLabel = (label: string) => visibleWidth(label) > width && width >= 8
    ? truncateToWidth(label, width, "…") : label;
  const info = [
    clippedLabel(cleanLabel(state.modelName || "unknown")),
    state.thinkingLevel ?? "?",
    contextLeft(state.context, state.modelContextWindow),
  ];
  const branch = cleanLabel(state.branch ?? "");
  if (branch) info.push(clippedLabel(`branch: ${branch}`));
  const usage: string[] = [];
  const view = state.view;
  if (view.status === "ready" && view.usage.provider === state.provider) {
    if (view.usage.provider === "openai-codex") {
      if (view.usage.fiveHour) usage.push(quota("5h", view.usage.fiveHour, state.now, width, paint));
      if (view.usage.sevenDay) usage.push(quota("7d", view.usage.sevenDay, state.now, width, paint));
    } else {
      for (const [index, row] of view.usage.balances.entries()) {
        usage.push(`${index === 0 ? "balance " : ""}${row.currency} ${row.amount}`);
      }
    }
  } else if (state.provider === "openai-codex" || state.provider === "deepseek") {
    const label = state.provider === "openai-codex" ? "Codex" : "DeepSeek";
    usage.push(`${label} ${view.status === "ready" ? "unavailable" : view.status}`);
  }
  const all = [...info, ...usage].join(" | ");
  if (visibleWidth(all) <= width) return [all];
  // Keep the two semantic groups on separate rows at ordinary terminal widths.
  return [...pack(info, width), ...pack(usage, width)];
}
