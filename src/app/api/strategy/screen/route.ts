import type { NextRequest } from "next/server";
import { body, handle } from "@/lib/strategy/http";
import { normalizeScreen, runScreen, SCREEN_AI_MODES, SCREEN_COUNTS, SCREEN_METRICS, SCREEN_POSITIONS } from "@/lib/strategy/screen";
import { listStrategies, StrategyError } from "@/lib/strategy/store";

export const maxDuration = 300;

/** 股票篩選的選項（前端表單用） */
export const GET = (req: NextRequest) =>
  handle(req, async () => ({ metrics: SCREEN_METRICS, positions: SCREEN_POSITIONS, counts: SCREEN_COUNTS, aiModes: SCREEN_AI_MODES }));

/** 執行篩選：{ screen } 直接給設定，或 { strategyId } 用策略裡的設定；回傳股票名單 */
export const POST = (req: NextRequest) =>
  handle(req, async (o) => {
    const b = await body<{ screen?: unknown; strategyId?: string }>(req);
    let screen = normalizeScreen(b.screen);
    if (!screen && b.strategyId) screen = (await listStrategies(o.userId)).find((s) => s.id === b.strategyId)?.config.screen ?? null;
    if (!screen) throw new StrategyError("沒有可用的股票篩選設定");
    return { items: await runScreen(screen, o.userId) };
  });
