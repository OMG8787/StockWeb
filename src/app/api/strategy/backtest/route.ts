import type { NextRequest } from "next/server";
import { body, handle } from "@/lib/strategy/http";
import { detectMarket, normalizeSymbol } from "@/lib/data";
import { listIndicators, listStrategies, prefetchStrategyTables, StrategyError } from "@/lib/strategy/store";
import { runBacktest } from "@/lib/strategy/backtest";
import { BACKTEST_MAX_SYMBOLS, getBacktestCandles, loadBacktestSeries } from "@/lib/strategy/backtestData";
import { warmUniverseBriefly } from "@/lib/strategy/runner";

// 第一次抓 30 檔 5 年日K加上逐日判斷，給足時間（Vercel Hobby 上限內）
export const maxDuration = 300;

const YEARS = [1, 2, 3] as const;

/** 策略回測：{ strategyId, symbols: string[], years: 1|2|3, initialCash } → 回測結果（見 lib/strategy/backtest.ts） */
export const POST = (req: NextRequest) =>
  handle(req, async (o) => {
    const b = await body<{ strategyId?: string; symbols?: unknown; years?: unknown; initialCash?: unknown }>(req);
    await prefetchStrategyTables(o.userId);
    const [strategies, indicators] = await Promise.all([listStrategies(o.userId), listIndicators(o.userId)]);
    const strategy = strategies.find((s) => s.id === b.strategyId);
    if (!strategy) throw new StrategyError("請先選一個自己建立的策略（內建的 AI 建議策略沒有歷史評等，不能回測）");
    const raw = Array.isArray(b.symbols) ? b.symbols : [];
    const symbols = [...new Set(raw.map((x) => normalizeSymbol(String(x))).filter(Boolean))].slice(0, BACKTEST_MAX_SYMBOLS);
    if (symbols.length === 0) throw new StrategyError("請至少輸入一檔股票");
    const years = (YEARS as readonly number[]).includes(Number(b.years)) ? Number(b.years) : 1;
    const initialCash = Math.min(1_000_000_000, Math.max(10_000, Math.round(Number(b.initialCash) || 1_000_000)));
    await warmUniverseBriefly();
    const targets = symbols.map((s) => ({ symbol: s, market: (detectMarket(s) === "US" ? "US" : "TW") as "TW" | "US" }));
    const [series, bench] = await Promise.all([loadBacktestSeries(targets), getBacktestCandles("0050", "TW")]);
    const latest = (bench ?? series.find((s) => s.candles.length)?.candles ?? []).at(-1)?.time;
    if (!latest) throw new StrategyError("抓不到歷史日K（資料來源暫時忙碌），請稍後再試");
    const start = new Date(`${latest}T00:00:00Z`);
    start.setUTCFullYear(start.getUTCFullYear() - years);
    const result = runBacktest({ cfg: strategy.config, indicators, series, bench, startDay: start.toISOString().slice(0, 10), initialCash });
    return { strategy: { id: strategy.id, name: strategy.name }, years, symbols, result: { ...result, trades: result.trades.slice(-300) } };
  });
