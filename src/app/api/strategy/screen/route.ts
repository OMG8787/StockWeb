import type { NextRequest } from "next/server";
import { body, handle } from "@/lib/strategy/http";
import { normalizeSources, runSources, SCREEN_AI_MODES, SCREEN_COUNTS, SCREEN_METRICS, SCREEN_POSITIONS } from "@/lib/strategy/screen";
import { listStrategies, StrategyError } from "@/lib/strategy/store";

export const maxDuration = 300;

/** 股票篩選的選項（前端表單用） */
export const GET = (req: NextRequest) =>
  handle(req, async () => ({ metrics: SCREEN_METRICS, positions: SCREEN_POSITIONS, counts: SCREEN_COUNTS, aiModes: SCREEN_AI_MODES }));

/**
 * 預覽名單：{ sources, mode } 直接給來源（可複選）；strategyId 用來展開「依策略選股」，
 * 只給 { strategyId } 時預覽該策略本身的篩選。回傳每檔股票來自哪些來源（tags＝來源序號）。
 */
export const POST = (req: NextRequest) =>
  handle(req, async (o) => {
    const b = await body<{ sources?: unknown; mode?: string; strategyId?: string }>(req);
    const strategy = b.strategyId ? (await listStrategies(o.userId)).find((s) => s.id === b.strategyId) : undefined;
    if (b.strategyId && !strategy) throw new StrategyError("找不到選擇的策略", 404);
    let sources = normalizeSources(b.sources, { allowStrategy: true });
    let mode: "union" | "intersect" = b.mode === "intersect" ? "intersect" : "union";
    if (!sources.length && strategy) {
      sources = strategy.config.screens;
      mode = strategy.config.screenMode;
    }
    if (!sources.length) throw new StrategyError("請至少選一個股票來源");
    if (sources.some((s) => s.source === "strategy") && !strategy?.config.screens.length)
      throw new StrategyError("「依策略選股」要先選一個有設定股票篩選的策略");
    const strategySources = strategy?.config.screens.length ? { sources: strategy.config.screens, mode: strategy.config.screenMode } : null;
    return runSources(sources, mode, o.userId, { strategySources });
  });
