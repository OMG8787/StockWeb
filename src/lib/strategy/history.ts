import type { EvalContext } from "./indicatorCatalog";
import { evaluateStrategy, type StrategyConfig, type StrategyDecision, type UserIndicator } from "./engine";

/**
 * 策略的逐日訊號（策略疊圖、即時提醒共用）。純計算，資料由呼叫端準備。
 *
 * 第 i 天的判斷只用「截到那一天為止」的日K，不會偷看未來。籌碼、基本面、月營收、本站評等
 * 沒有逐日歷史，只在最新一天判斷（歷史日子這些指標視為資料不足）。
 */

export type Signal = "buy" | "sell" | null;

/** 內建的「AI 建議策略」＝本站綜合評等（程式計算、與個股頁相同） */
export const AI_STRATEGY_ID = "ai";
export const AI_STRATEGY_NAME = "🤖 AI 建議策略（本站綜合評等）";

export function decisionSignal(d: Pick<StrategyDecision, "buy" | "sell">): Signal {
  return d.buy ? "buy" : d.sell ? "sell" : null;
}

/** 本站評等代碼 → 訊號：建議買進（含拉回加碼）＝買進；先不要買＝賣出側（不建議持有／買進） */
export function ratingSignal(code: string | null | undefined): Signal {
  if (code === "buy" || code === "buy-on-pullback") return "buy";
  if (code === "avoid") return "sell";
  return null;
}

/**
 * 最近 days 根日K每一天的策略訊號（與 ctx.candles 的最後 days 根對齊）。
 * 最新一天用完整 ctx（含籌碼、基本面、評等），之前的日子只用截斷的日K。
 */
export function strategySignalSeries(
  cfg: StrategyConfig,
  indicators: UserIndicator[],
  ctx: EvalContext,
  days: number,
): { signals: Signal[]; latest: StrategyDecision } {
  const n = ctx.candles.length;
  const start = Math.max(0, n - days);
  const signals: Signal[] = [];
  for (let i = start; i < n - 1; i++) {
    const past: EvalContext = { symbol: ctx.symbol, market: ctx.market, candles: ctx.candles.slice(0, i + 1) };
    signals.push(decisionSignal(evaluateStrategy(cfg, indicators, past)));
  }
  const latest = evaluateStrategy(cfg, indicators, ctx);
  signals.push(decisionSignal(latest));
  return { signals, latest };
}

/** 每一天是否「所有策略都是買進」（任何一個策略那天沒有訊號就不算） */
export function consensusBuy(series: Signal[][]): boolean[] {
  if (series.length === 0) return [];
  const len = Math.max(...series.map((s) => s.length));
  return Array.from({ length: len }, (_, i) => series.every((s) => s[i] === "buy"));
}
