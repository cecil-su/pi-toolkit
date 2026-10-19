import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveIdentity, supported } from "./auth.ts";
import { registerDeepSeekTools } from "./deepseek-tools.ts";
import { registerFast } from "./fast.ts";
import type { FastPreferences } from "./fast-preferences.ts";
import { ReadThrottle } from "./http.ts";
import { UsageMonitor } from "./monitor.ts";
import { paintBar, renderFooter } from "./render.ts";

export default function statusbar(pi: ExtensionAPI, preferences?: FastPreferences): void {
  registerDeepSeekTools(pi);
  let active: {
    stop(): void;
    release(): void;
    refresh(force?: boolean, invalidate?: boolean): void;
    repaint(): void;
    compacting: boolean;
  } | undefined;

  const usageThrottle = new ReadThrottle(60_000);
  const fast = registerFast(pi, () => active?.repaint(), preferences);
  const release = () => { active?.release(); };

  function mount(ctx: ExtensionContext): void {
    release();
    if (ctx.mode !== "tui") return; // No auth resolution, HTTP or timers in print/JSON/RPC.
    let ended = false;
    let repaint = () => {};
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setInterval> | undefined;
    let modelKey = "";
    const monitor = new UsageMonitor(async (signal) => {
      const model = ctx.model;
      if (!model || !supported(model.provider)) return undefined;
      return resolveIdentity(model, ctx.modelRegistry, signal);
    }, () => repaint(), undefined, Date.now, usageThrottle);
    const syncModel = () => {
      const model = ctx.model;
      const next = JSON.stringify([model?.provider, model?.id, model?.api, model?.baseUrl]);
      if (next !== modelKey) { modelKey = next; monitor.invalidate(); }
    };
    const running = {
      compacting: false,
      stop() {
        if (ended) return;
        ended = true;
        if (timer !== undefined) clearInterval(timer);
        monitor.stop();
        unsubscribe();
        repaint = () => {};
        if (active === running) active = undefined;
      },
      release() {
        if (ended) return;
        running.stop();
        ctx.ui.setFooter(undefined);
      },
      refresh(force = false, invalidate = false) {
        if (ended) return;
        if (invalidate) monitor.invalidate();
        syncModel();
        void monitor.poll(force);
        repaint();
      },
      repaint() { repaint(); },
    };
    active = running;
    ctx.ui.setFooter((tui, _theme, footer) => {
      repaint = () => { if (!ended) tui.requestRender(); };
      unsubscribe = footer.onBranchChange(repaint);
      return {
        invalidate() {},
        dispose() { running.stop(); },
        render(width) {
          if (ended) return [];
          syncModel();
          const theme = ctx.ui.theme;
          const context = ctx.getContextUsage();
          return renderFooter({
            modelName: ctx.model?.name,
            thinkingLevel: ctx.thinkingLevel,
            fast: fast.effective(ctx),
            provider: ctx.model?.provider,
            context: running.compacting && context ? { ...context, tokens: null, percent: null } : context,
            modelContextWindow: ctx.model?.contextWindow,
            branch: footer.getGitBranch(),
            view: monitor.view(),
            now: Date.now(),
          }, width, (body) => `\x1b[22m${paintBar(body, theme)}${theme.getFgAnsi("muted")}`)
            .map((line) => theme.fg("muted", line));
        },
      };
    });
    if (ended) return;
    syncModel();
    timer = setInterval(() => running.refresh(), 1000);
    timer.unref?.();
    running.refresh();
  }

  pi.on("session_start", (_event, ctx) => mount(ctx));
  pi.on("session_shutdown", () => release());
  pi.on("model_select", () => active?.refresh(true, true));
  pi.on("thinking_level_select", () => active?.repaint());
  pi.on("before_agent_start", () => { active?.refresh(true); });
  pi.on("input", () => { active?.refresh(true); });
  pi.on("session_before_compact", () => {
    if (active) { active.compacting = true; active.repaint(); }
  });
  pi.on("session_compact", () => {
    if (active) { active.compacting = false; active.refresh(); }
  });
  pi.on("session_compact_failed", () => {
    if (active) { active.compacting = false; active.repaint(); }
  });
  pi.on("message_update", () => active?.repaint());
  pi.on("message_end", () => active?.refresh());
  pi.on("agent_end", () => active?.refresh(true));
  pi.on("session_tree", () => active?.refresh());
}
