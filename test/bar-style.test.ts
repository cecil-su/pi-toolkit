import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Color, colorToRgb, rgbColor, stripTerminalSequences, styleText, type TerminalColorMode, visibleWidth } from "@earendil-works/pi-tui";
import statusbar from "../src/index.ts";
import { bar, paintBar, percent, renderFooter } from "../src/render.ts";

function themeFor(appearance: "dark" | "light", mode: TerminalColorMode, accent: Color = rgbColor(60, 150, 200)): Parameters<typeof paintBar>[1] {
  return {
    appearance, colors: { accent },
    style(text, options) {
      const { fg, bg, ...attributes } = options;
      if (typeof fg === "string" || typeof bg === "string") assert.fail("Expected concrete colors");
      return styleText(text, { ...attributes, fg, bg }, mode);
    },
  };
}

/** A small SGR observer, not a renderer: checks every emitted glyph and final state. */
function scan(line: string) {
  let fg: string | undefined, bg: string | undefined;
  let dim = false;
  const glyphs: { char: string; fg?: string; bg?: string; dim: boolean }[] = [];
  for (let i = 0; i < line.length;) {
    if (line.startsWith("\x1b[", i)) {
      const end = line.indexOf("m", i);
      assert.ok(end >= 0);
      const codes = line.slice(i + 2, end).split(";").map(Number);
      for (let c = 0; c < codes.length; c++) {
        const code = codes[c];
        if (code === 0) { fg = bg = undefined; dim = false; }
        else if (code === 2) dim = true;
        else if (code === 22) dim = false;
        else if (code === 39) fg = undefined;
        else if (code === 49) bg = undefined;
        else if (code === 38 || code === 48) {
          const count = codes[c + 1] === 2 ? 4 : 2;
          const color = codes.slice(c + 1, c + 1 + count).join(";");
          if (code === 38) fg = color;
          else bg = color;
          c += count;
        }
      }
      i = end + 1;
    } else {
      const char = String.fromCodePoint(line.codePointAt(i) ?? 0);
      glyphs.push({ char, fg, bg, dim });
      i += char.length;
    }
  }
  return { glyphs, fg, bg, dim };
}

test("one dark track covers full blocks, partial blocks and spaces, including 0/100", () => {
  for (const appearance of ["dark", "light"] as const) for (const mode of ["truecolor", "256color"] as const) {
    const theme = themeFor(appearance, mode);
    const style = theme.style;
    theme.style = (body, options) => {
      const { fg, bg } = options;
      assert.ok(fg && bg && typeof fg !== "string" && typeof bg !== "string");
      const fill = colorToRgb(fg), track = colorToRgb(bg);
      assert.ok(Math.max(track.r, track.g, track.b) < 100);
      assert.ok(Math.min(fill.r, fill.g, fill.b) > 160);
      return style(body, options);
    };
    for (const remaining of [0, 0.625, 63, 100]) {
      const text = paintBar(bar(remaining), theme);
      const { glyphs, fg, bg } = scan(text);
      assert.equal(glyphs.map((cell) => cell.char).join(""), bar(remaining));
      assert.equal(visibleWidth(text), 10);
      assert.equal(new Set(glyphs.map((cell) => cell.bg)).size, 1);
      assert.ok(glyphs.every((cell) => cell.bg && cell.fg && cell.bg !== cell.fg));
      assert.equal(fg, undefined);
      assert.equal(bg, undefined);
      assert.doesNotMatch(text, /░/);
      assert.ok(text.includes(mode === "256color" ? "[48;5;" : "[48;2;"));
      if (mode === "256color") assert.ok(!text.includes("[38;2;") && !text.includes("[48;2;"));
    }
  }
});

test("paint uses the current appearance/accent on every render, without cached ANSI", () => {
  let theme = themeFor("dark", "truecolor");
  const first = paintBar(bar(63), theme);
  theme = themeFor("light", "truecolor", rgbColor(180, 50, 100));
  const changed = paintBar(bar(63), theme);
  assert.notEqual(first, changed);
  assert.equal(stripTerminalSequences(first), stripTerminalSequences(changed));
});

test("styled layouts 0–200 preserve track spaces, restore/reset split rows and never color brackets or text", () => {
  const now = 1_800_000_000_000;
  for (const appearance of ["dark", "light"] as const) for (const mode of ["truecolor", "256color"] as const) {
    const theme = themeFor(appearance, mode);
    for (const remaining of [0, 63, 100]) for (let width = 0; width <= 200; width++) {
      const bodies: string[] = [];
      const lines = renderFooter({
        modelName: "M", provider: "openai-codex", branch: "main", now,
        context: { tokens: 25, contextWindow: 100, percent: 25 },
        view: { status: "ready", usage: { provider: "openai-codex",
          fiveHour: { remaining, resetsAt: now + 14880000 },
          sevenDay: { remaining, resetsAt: now + 399600000 },
        } },
      }, width, (body) => { bodies.push(body); return paintBar(body, theme); });
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow: ${width}`);
      if (!width) { assert.deepEqual(lines, []); assert.deepEqual(bodies, []); continue; }
      const rows = lines.map(scan);
      assert.ok(rows.every((row) => row.bg === undefined && row.fg === undefined), `unclosed row: ${width}`);
      const glyphs = rows.flatMap((row) => row.glyphs);
      assert.equal(glyphs.filter((cell) => cell.bg !== undefined).map((cell) => cell.char).join(""), bodies.join(""),
        `bar glyph/space lost across wrapping at ${width}`);
      const plain = glyphs.map((cell) => cell.char).join("");
      const covered = new Set<number>();
      for (const match of plain.matchAll(/\[([█▏▎▍▌▋▊▉ ]+)\]/g)) {
        for (let i = match.index + 1; i < match.index + 1 + match[1].length; i++) covered.add(i);
      }
      glyphs.forEach((cell, i) => {
        assert.equal(cell.bg !== undefined, covered.has(i), `background leaked at ${width}: ${cell.char}`);
        if (!covered.has(i)) assert.equal(cell.fg, undefined, `fill leaked outside bar at ${width}`);
      });
      const compact = plain.replace(/\s/g, "");
      assert.ok(compact.includes("ctx75%/100"));
      // Existing label-ellipsis policy applies at widths 8–11; quota values never truncate.
      if (width < 8 || width >= 12) assert.ok(compact.includes("branch:main"));
      assert.ok(compact.includes(`]${percent(remaining)}~4h8m`) && compact.includes(`]${percent(remaining)}~4d15h`));
      assert.ok(compact.includes("5h[") && compact.includes("7d["));
      assert.equal(bodies.length, 2);
    }
  }
});

test("real Pi dark/light Theme: final index composition preserves bright fill, muted text and split-row resets in both color modes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const dist = new URL("./", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { loadThemeFromPath } = await import(new URL("modes/interactive/theme/theme.js", dist).href) as {
    loadThemeFromPath(path: string, mode: TerminalColorMode): Theme;
  };
  let currentTheme = loadThemeFromPath(fileURLToPath(new URL("modes/interactive/theme/dark.json", dist)), "truecolor");
  type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
  let component: ReturnType<FooterFactory> | undefined;
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const fire = (name: string) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) {
      result = result instanceof Promise ? result.then(() => handler({}, ctx)) : handler({}, ctx);
    }
    return result;
  };
  const now = Date.now();
  const claims = { sub: "synthetic-user", exp: now / 1000 + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } };
  const token = `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic`;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ rate_limit: {
    primary_window: { used_percent: 37, limit_window_seconds: 18000, reset_at: Math.floor(now / 1000) + 14880 },
    secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_at: Math.floor(now / 1000) + 399600 },
  } })));
  let branch = "main";
  const ctx = {
    mode: "tui",
    model: { provider: "openai-codex", id: "synthetic-model", name: "M", api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api" } as Model<Api>,
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }), isUsingOAuth: () => true },
    getContextUsage: () => ({ tokens: 25, percent: 25, contextWindow: 100 }),
    ui: {
      get theme() { return currentTheme; },
      setFooter(factory: FooterFactory | undefined) {
        component?.dispose?.();
        component = factory?.({ requestRender() {} } as Parameters<FooterFactory>[0], currentTheme, {
          getGitBranch: () => branch, onBranchChange: () => () => {},
          getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1,
        });
      },
    },
  };
  statusbar({ registerCommand() {}, on(name: string, handler: (event: unknown, context: unknown) => unknown) {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
    return () => {};
  } } as unknown as ExtensionAPI, { load: async () => false, save: async () => {} });
  try {
    await fire("session_start");
    await settle();
    assert.ok(component);
    let previous = "";
    for (const mode of ["truecolor", "256color"] as const) for (const name of ["dark", "light"]) {
      currentTheme = loadThemeFromPath(fileURLToPath(new URL(`modes/interactive/theme/${name}.json`, dist)), mode);
      ctx.model.name = "M";
      branch = "main";
      component.invalidate();
      const wide = component.render(200).join("");
      assert.notEqual(wide, previous);
      previous = wide;
      assert.ok(wide.includes(`\x1b[22m${paintBar(bar(63), currentTheme)}${currentTheme.getFgAnsi("muted")}]`));
      if (mode === "256color") assert.ok(!wide.includes("[38;2;") && !wide.includes("[48;2;"));
      const muted = scan(currentTheme.fg("muted", "x")).glyphs[0];
      const fill = scan(paintBar(bar(63), currentTheme)).glyphs[0].fg;
      for (const longLabels of [false, true]) for (let width = 0; width <= 200; width++) {
        ctx.model.name = longLabels ? "very-long-model-name-".repeat(16) : "M";
        branch = longLabels ? "feature/very-long-branch-name-".repeat(16) : "main";
        const lines = component.render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        if (!width) { assert.deepEqual(lines, []); continue; }
        const rows = lines.map(scan);
        for (const row of rows) {
          assert.equal(row.bg, undefined);
          assert.equal(row.fg, undefined);
          assert.equal(row.dim, false);
          for (const cell of row.glyphs) {
            if (cell.bg) { assert.equal(cell.dim, false); assert.equal(cell.fg, fill); }
          }
        }
        const glyphs = rows.flatMap((row) => row.glyphs);
        const plain = glyphs.map((cell) => cell.char).join("");
        const covered = new Set<number>();
        const bodies = [...plain.matchAll(/\[([█▏▎▍▌▋▊▉ ]+)\]/g)];
        assert.equal(bodies.length, 2);
        for (const match of bodies) for (let i = match.index + 1; i <= match.index + match[1].length; i++) covered.add(i);
        assert.ok(plain.includes("5h"));
        glyphs.forEach((cell, i) => {
          assert.equal(cell.bg !== undefined, covered.has(i));
          if (!covered.has(i)) {
            assert.equal(cell.fg, muted.fg, `text color at width ${width}: ${cell.char}`);
            assert.equal(cell.dim, muted.dim);
          }
        });
        const compact = plain.replace(/\s/g, "");
        assert.ok(compact.includes("ctx75%/100"));
        if (!longLabels && (width < 8 || width >= 12)) assert.ok(compact.includes("branch:main"));
        if (longLabels && width >= 8) assert.ok(compact.endsWith("…"));
        assert.ok(compact.indexOf("branch:") > compact.indexOf("]40%~"));
        assert.ok(compact.includes("]63%~") && compact.includes("]40%~"));
      }
    }
  } finally { await fire("session_shutdown"); }
});
