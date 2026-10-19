import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { parseCodex, parseDeepSeek, type UsageView } from "../src/data.ts";
import { bar, cleanLabel, contextLeft, countdown, formatContextWindow, percent, renderFooter } from "../src/render.ts";

const now = 1_800_000_000_000;
const window = (seconds: number, used: number, reset = now / 1000 + 14880) => ({
  limit_window_seconds: seconds, used_percent: used, reset_at: reset,
});
const root = () => ({ account_id: "synthetic-account", rate_limit: {
  primary_window: window(18000, 37), secondary_window: window(604800, 60, now / 1000 + 399600),
} });

test("Codex uses actual durations, remaining percentages and absolute resets", () => {
  assert.deepEqual(parseCodex(root(), "synthetic-account"), {
    provider: "openai-codex", fiveHour: { remaining: 63, resetsAt: now + 14880000 },
    sevenDay: { remaining: 40, resetsAt: now + 399600000 },
  });
  const swapped = root();
  [swapped.rate_limit.primary_window, swapped.rate_limit.secondary_window] =
    [swapped.rate_limit.secondary_window, swapped.rate_limit.primary_window];
  assert.deepEqual(parseCodex(swapped, "synthetic-account"), parseCodex(root(), "synthetic-account"));
});

test("valid root + unrelated opaque additional buckets never hide account windows", () => {
  const payload = { ...root(), additional_rate_limits: [{ metered_feature: "opaque-special-feature",
    limit_name: "special", rate_limit: { primary_window: window(18000, 99) } }] };
  assert.deepEqual(parseCodex(payload, "synthetic-account"), parseCodex(root(), "synthetic-account"));
  assert.throws(() => parseCodex({ additional_rate_limits: payload.additional_rate_limits }, "synthetic-account"));
});

test("Codex rejects account mismatches, malformed/duplicate values and never relabels durations", () => {
  assert.throws(() => parseCodex(root(), "different-account"));
  for (const bad of [-1, 101, NaN, Infinity, "37", null]) {
    const payload = { rate_limit: { primary_window: { ...window(18000, 20), used_percent: bad } } };
    assert.throws(() => parseCodex(payload, "synthetic-account"));
  }
  assert.throws(() => parseCodex({ rate_limit: { primary_window: window(3600, 20) } }, "a"));
  assert.throws(() => parseCodex({ rate_limit: { primary_window: window(18000, 20), secondary_window: window(18000, 30) } }, "a"));
  assert.deepEqual(parseCodex({ rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 } } }, "a"), {
    provider: "openai-codex", fiveHour: { remaining: 0, resetsAt: undefined },
  });
  for (const reset of ["123", -1, Infinity, 1.5, 9e15]) {
    assert.throws(() => parseCodex({ rate_limit: { primary_window: { ...window(18000, 0), reset_at: reset } } }, "a"));
  }
});

test("DeepSeek preserves exact decimal strings, currency and availability", () => {
  const result = parseDeepSeek({ is_available: false, balance_infos: [
    { currency: "USD", total_balance: "-0.0000000000000000001" },
    { currency: "CNY", total_balance: "123456789012345678901234567890.00100" },
  ] });
  assert.deepEqual(result, { provider: "deepseek", available: false, balances: [
    { currency: "USD", amount: "-0.0000000000000000001" },
    { currency: "CNY", amount: "123456789012345678901234567890.00100" },
  ] });
  for (const bad of [42, "NaN", "1e3", "1\n2", "0x1", "Infinity", "1.2 USD", ""]) {
    assert.throws(() => parseDeepSeek({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: bad }] }));
  }
  for (const rows of [[], [{ currency: "EUR", total_balance: "1.00" }],
    [{ currency: "USD", total_balance: "1" }, { currency: "USD", total_balance: "2" }]]) {
    assert.throws(() => parseDeepSeek({ is_available: true, balance_infos: rows }));
  }
  assert.throws(() => parseDeepSeek({ is_available: "true", balance_infos: [{ currency: "CNY", total_balance: "0" }] }));
});

test("bars quantize to nearest eighth-cell from the same remaining value", () => {
  assert.equal(bar(0), " ".repeat(10));
  assert.equal(bar(100), "█".repeat(10));
  assert.equal(bar(63), "██████▎   ");
  assert.equal(bar(0.625), "▏         ");
  assert.equal(bar(0.624), " ".repeat(10));
  assert.equal(bar(99.374), "█████████▉");
  assert.equal(bar(99.375), "██████████");
  const fractions = "▏▎▍▌▋▊▉";
  for (const n of [0, 0.001, 0.624, 0.625, 1.25, 37.001, 63, 99.374, 99.375, 99.999, 100]) {
    for (const cells of [2, 7, 10]) {
      const value = bar(n, cells);
      assert.equal(visibleWidth(value), cells);
      const units = [...value].reduce((sum, c) => sum + (c === "█" ? 8 : c === " " ? 0 : fractions.indexOf(c) + 1), 0);
      assert.equal(units, Math.round(n / 100 * cells * 8));
    }
  }
  assert.equal(percent(0.001), "<0.01%");
  assert.equal(percent(99.999), ">99.99%");
});

test("ctx explicitly means remaining; unknown/compacted is never 100%", () => {
  assert.equal(contextLeft({ tokens: 200, contextWindow: 1000, percent: 20 }), "ctx 80%/1k");
  assert.equal(contextLeft({ tokens: null, contextWindow: 1000, percent: null }), "ctx ?/1k");
  assert.equal(contextLeft(), "ctx ?/?");
  assert.equal(contextLeft({ tokens: 0, contextWindow: 1000, percent: 0 }), "ctx 100%/1k");
  assert.equal(contextLeft({ tokens: 1100, contextWindow: 1000, percent: 110 }), "ctx 0%/1k");
});

test("context window uses runtime usage first, model fallback second and decimal k/M formatting", () => {
  for (const [value, label] of [[999, "999"], [1000, "1k"], [272000, "272k"], [500000, "500k"],
    [123450, "123.45k"], [1000000, "1M"], [1050000, "1.05M"], [1048576, "1.05M"]] as const) {
    assert.equal(formatContextWindow(value), label);
  }
  for (const value of [undefined, 0, -1, NaN, Infinity]) assert.equal(formatContextWindow(value), "?");
  assert.equal(contextLeft({ tokens: 50000, contextWindow: 500000, percent: 10 }, 272000), "ctx 90%/500k");
  assert.equal(contextLeft({ tokens: null, contextWindow: 500000, percent: null }, 272000), "ctx ?/500k");
  assert.equal(contextLeft(undefined, 272000), "ctx ?/272k");
  assert.equal(contextLeft({ tokens: 100, contextWindow: 0, percent: 10 }, 1050000), "ctx 90%/1.05M");
  assert.equal(contextLeft({ tokens: null, contextWindow: NaN, percent: null }, 500000), "ctx ?/500k");
  assert.equal(contextLeft({ tokens: null, contextWindow: 0, percent: null }, 0), "ctx ?/?");
});

test("missing/blank branches are omitted with no orphan separators at any width", () => {
  for (const branch of [undefined, null, "", " \t\n ", "\x1b[31m \x1b[0m", "\u202e"]) {
    const state = { modelName: "M", thinkingLevel: "off" as const, branch, modelContextWindow: 500000,
      view: { status: "unsupported" as const }, now };
    assert.deepEqual(renderFooter(state, 200), ["M | off | ctx ?/500k"]);
    for (let width = 0; width <= 200; width++) {
      const lines = renderFooter(state, width).map(stripTerminalSequences);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.doesNotMatch(lines.join(""), /branch:/);
      for (const line of lines) assert.doesNotMatch(line, /^\s*\||\|\s*$|\|\s*\|/);
    }
  }
  const withBranch = renderFooter({ modelName: "M", thinkingLevel: "high", branch: " main ",
    view: { status: "unsupported" }, now }, 200);
  assert.deepEqual(withBranch, ["M | high | ctx ?/? | branch: main"]);
  assert.deepEqual(renderFooter({ modelName: "M", view: { status: "unsupported" }, now }, 200), ["M | ? | ctx ?/?"]);
});

test("thinking is a separate field and survives model-name truncation", () => {
  for (const thinkingLevel of ["high", "off", "xhigh"] as const) for (let width = 1; width <= 200; width++) {
    const lines = renderFooter({ modelName: "very-long-model-name-".repeat(4), thinkingLevel,
      view: { status: "unsupported" }, now }, width).map(stripTerminalSequences);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.join("").replace(/\s/g, "").includes(thinkingLevel));
    for (const line of lines) assert.doesNotMatch(line, /^\s*\||\|\s*$|\|\s*\|/);
  }
});

test("ready Codex displays only returned windows, preserving 0% and clean separators", () => {
  for (const [label, missing, seconds] of [["5h", "7d", 18000], ["7d", "5h", 604800]] as const) {
    const usage = parseCodex({ rate_limit: { primary_window: window(seconds, 100) } }, "a");
    const state = { modelName: "M", thinkingLevel: "off" as const, branch: null, provider: "openai-codex", now,
      context: { tokens: 50000, contextWindow: 500000, percent: 10 }, view: { status: "ready" as const, usage } };
    const wide = renderFooter(state, 200).join("");
    assert.ok(wide.includes(`${label} [`));
    assert.match(wide, /\] 0% ~/);
    assert.ok(!wide.includes(missing));
    assert.doesNotMatch(wide, /unavailable|branch:/);
    assert.equal(wide.split(" | ").length, 4);
    for (let width = 0; width <= 200; width++) {
      const lines = renderFooter(state, width).map(stripTerminalSequences);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      for (const line of lines) assert.doesNotMatch(line, /^\s*\||\|\s*$|\|\s*\|/);
      const compact = lines.join("").replace(/\s/g, "");
      if (width) assert.ok(compact.includes(`${label}[`) && compact.includes("]0%~"));
      assert.ok(!compact.includes(missing));
    }
  }
});

test("whole-query loading/unavailable/stale remain explicit rather than masquerading as unlimited", () => {
  for (const status of ["loading", "unavailable", "stale"] as const) for (let width = 1; width <= 200; width++) {
    const lines = renderFooter({ modelName: "M", thinkingLevel: "off", provider: "openai-codex", branch: " ",
      view: { status }, now }, width).map(stripTerminalSequences);
    const compact = lines.join("").replace(/\s/g, "");
    assert.ok(compact.includes(`Codex${status}`));
    assert.doesNotMatch(compact, /branch:|5h|7d|100%|0%/);
    for (const line of lines) assert.doesNotMatch(line, /^\s*\||\|\s*$|\|\s*\|/);
  }
});

test("reset countdowns use absolute time and never infer a refreshed balance", () => {
  assert.equal(countdown(now + 14880000, now), "~4h8m");
  assert.equal(countdown(now + 399600000, now), "~4d15h");
  assert.equal(countdown(now + 59000, now), "~<1m");
  assert.equal(countdown(now, now), "reset due");
  assert.equal(countdown(undefined, now), "~?");
  const usage = parseCodex(root(), "synthetic-account");
  const lines = renderFooter({ provider: "openai-codex", view: { status: "ready", usage }, now: now + 500000000 }, 160);
  assert.match(lines.join("\n"), /5h reset due.*7d reset due/s);
  assert.doesNotMatch(lines.join("\n"), /63%|40%|100%/);
});

test("fields fill rows continuously, wrapping whole fields/windows with branch always last", () => {
  const state = { modelName: "GPT Test", thinkingLevel: "high" as const, fast: true, provider: "openai-codex",
    context: { tokens: 20, contextWindow: 100, percent: 20 },
    branch: "main", view: { status: "ready", usage: parseCodex(root(), "synthetic-account") } as UsageView, now };
  const info = "GPT Test | high | fast | ctx 80%/100";
  const fiveHour = "5h [██████▎   ] 63% ~4h8m";
  const sevenDay = "7d [████      ] 40% ~4d15h";
  assert.deepEqual(renderFooter(state, 200), [`${info} | ${fiveHour} | ${sevenDay} | branch: main`]);
  assert.deepEqual(renderFooter(state, 90), [`${info} | ${fiveHour}`, `${sevenDay} | branch: main`]);
  const narrow = renderFooter(state, 38);
  assert.ok(narrow.some((line) => line.startsWith("5h [") && line.endsWith("~4h8m")));
  assert.ok(narrow.some((line) => line.startsWith("7d [") && line.endsWith("~4d15h")));
  assert.equal(narrow.at(-1), "branch: main");
});

test("single 7d, dual windows and multiple currencies wrap only at the current field's width boundary", () => {
  const cases = [
    { name: "single 7d", provider: "openai-codex", usage: parseCodex({ rate_limit: {
      primary_window: window(604800, 60, now / 1000 + 399600),
    } }, "synthetic-account"), fields: ["7d [████      ] 40% ~4d15h"] },
    { name: "dual windows", provider: "openai-codex", usage: parseCodex(root(), "synthetic-account"),
      fields: ["5h [██████▎   ] 63% ~4h8m", "7d [████      ] 40% ~4d15h"] },
    { name: "multiple currencies", provider: "deepseek", usage: parseDeepSeek({ is_available: true, balance_infos: [
      { currency: "CNY", total_balance: "110.00100" }, { currency: "USD", total_balance: "20.00000001" },
    ] }), fields: ["balance CNY 110.00100", "USD 20.00000001"] },
  ];
  for (const { name, provider, usage, fields } of cases) {
    const state = { modelName: "Synthetic 模型", thinkingLevel: "high" as const, fast: true, provider,
      context: { tokens: 20, contextWindow: 500000, percent: 20 },
      branch: "feature/synthetic-footer-layout-long-branch",
      view: { status: "ready" as const, usage }, now };
    const info = [state.modelName, "high", ...(provider === "openai-codex" ? ["fast"] : []), "ctx 80%/500k"];
    const branch = `branch: ${state.branch}`;
    const all = [...info, ...fields, branch].join(" | ");
    for (let index = 0; index < fields.length; index++) {
      const before = [...info, ...fields.slice(0, index)].join(" | ");
      const through = `${before} | ${fields[index]}`;
      const exactWidth = visibleWidth(through);
      for (const width of [exactWidth - 1, exactWidth]) {
        const lines = renderFooter(state, width);
        assert.equal(lines[0], width === exactWidth ? through : before, `${name} at ${width}`);
        assert.equal(lines.join(" | "), all, `${name}: fields preserved at ${width}`);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.ok(lines.at(-1)?.endsWith(branch));
      }
    }
    const allWidth = visibleWidth(all);
    assert.deepEqual(renderFooter(state, allWidth - 1), [[...info, ...fields].join(" | "), branch], name);
    assert.deepEqual(renderFooter(state, allWidth), [all], name);
    assert.deepEqual(renderFooter(state, allWidth + 1), [all], name);
  }
});

test("long branches never hide or precede quota, balances or status at narrow, ordinary and wide widths", () => {
  const codex = parseCodex(root(), "synthetic-account");
  const deepseek = parseDeepSeek({ is_available: true, balance_infos: [
    { currency: "CNY", total_balance: "110.001000" },
    { currency: "USD", total_balance: "0.12345678901234567890" },
  ] });
  const cases: { provider: string; view: UsageView; fields: string[] }[] = [
    { provider: "openai-codex", view: { status: "ready", usage: codex },
      fields: ["5h[", "]63%~4h8m", "7d[", "]40%~4d15h"] },
    { provider: "deepseek", view: { status: "ready", usage: deepseek },
      fields: ["balanceCNY110.001000", "USD0.12345678901234567890"] },
    { provider: "other", view: { status: "unsupported" }, fields: [] },
    { provider: "deepseek", view: { status: "ready", usage: codex }, fields: ["DeepSeekunavailable"] },
  ];
  for (const provider of ["openai-codex", "deepseek"]) {
    for (const status of ["loading", "unavailable", "stale", "unsupported"] as const) {
      cases.push({ provider, view: { status }, fields: [`${provider === "openai-codex" ? "Codex" : "DeepSeek"}${status}`] });
    }
  }
  const compact = (text: string) => stripTerminalSequences(text).replace(/[\s|]/g, "");
  const longBranch = "feature/very-long-branch-name-".repeat(16);
  const unicodeBranch = "feature/长分支-👩‍💻-e\u0301-".repeat(20);
  const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
  for (const { provider, view, fields } of cases) for (const branch of [undefined, "main", longBranch, unicodeBranch]) {
    for (const width of [...Array.from({ length: 201 }, (_, i) => i), 600]) {
      const state = { modelName: "M", thinkingLevel: "high" as const, fast: true, provider,
        context: { tokens: 20, contextWindow: 500000, percent: 20 }, branch, view, now };
      const lines = renderFooter(state, width);
      const message = `${provider}/${view.status}, width ${width}, branch ${branch?.length ?? 0}`;
      assert.ok(lines.every((line) => visibleWidth(line) <= width), message);
      if (!width) { assert.deepEqual(lines, []); continue; }
      for (const line of lines) assert.doesNotMatch(line, /^\s*\||\|\s*$|\|\s*\|/, message);
      const text = compact(lines.join(""));
      let offset = 0;
      for (const field of ["M", "high", ...(provider === "openai-codex" ? ["fast"] : []), "ctx80%/500k", ...fields]) {
        const index = text.indexOf(field, offset);
        assert.ok(index >= offset, `${message}: missing/out-of-order ${field}`);
        offset = index + field.length;
      }
      if (branch) {
        const label = `branch: ${branch}`;
        let clipped = visibleWidth(label) > width && width >= 8 ? truncateToWidth(label, width, "…") : label;
        // A one-column terminal cannot retain CJK/emoji graphemes; all narrower glyphs still survive.
        if (width === 1) clipped = [...graphemes.segment(label)]
          .filter(({ segment }) => visibleWidth(segment) <= width).map(({ segment }) => segment).join("");
        const baseline = compact(renderFooter({ ...state, branch: undefined }, width).join(""));
        assert.equal(text, baseline + compact(clipped), message);
      } else assert.doesNotMatch(text, /branch:/, message);
      if (width === 600) assert.equal(lines.length, 1, message);
    }
  }
});

test("all Unicode widths fit, control codes are stripped and foreign provider data is hidden", () => {
  assert.equal(cleanLabel("\x1b[31m测试\x1b[0m\n\u202eX"), "测试  X");
  const views: UsageView[] = [{ status: "loading" }, { status: "unavailable" }, { status: "stale" },
    { status: "ready", usage: parseCodex(root(), "synthetic-account") },
    { status: "ready", usage: parseDeepSeek({ is_available: true, balance_infos: [
      { currency: "CNY", total_balance: "110.001000" }, { currency: "USD", total_balance: "0.12345678901234567890" },
    ] }) }];
  for (const view of views) for (const provider of ["openai-codex", "deepseek", "other"]) {
    for (let width = 0; width <= 200; width++) {
      const lines = renderFooter({ modelName: "测试 👩‍💻 e\u0301模型非常长".repeat(3), branch: "分支/👨‍👩‍👧‍👦e\u0301", provider, view, now }, width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}: ${lines}`);
    }
  }
  const money = renderFooter({ provider: "deepseek", view: views[4], now }, 200).join(" ");
  assert.match(money, /CNY 110.001000.*USD 0.12345678901234567890/);
  assert.doesNotMatch(money, /~|█|░/); // The independent ctx-left field may contain a percentage.
  assert.doesNotMatch(money.split("balance ")[1], /%/);
  const narrowMoney = renderFooter({ provider: "deepseek", view: views[4], now }, 12).join("").replace(/\s/g, "");
  assert.match(narrowMoney, /CNY110.001000/);
  assert.match(narrowMoney, /USD0.12345678901234567890/);
  const foreign = renderFooter({ provider: "deepseek", view: views[3], now }, 200).join(" ");
  assert.doesNotMatch(foreign, /63%|40%|5h|7d/);
});
