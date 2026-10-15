import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/data/types";
import { runBacktest, unsupportedIndicators } from "@/lib/strategy/backtest";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig, type UserIndicator } from "@/lib/strategy/engine";

/** 從 2025-01-01 起每天一根（不管週末，回測只看日K順序） */
function candles(closes: number[], opens?: number[]): Candle[] {
  return closes.map((c, i) => {
    const d = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    const o = opens?.[i] ?? c;
    return { time: d, open: o, high: Math.max(o, c) * 1.01, low: Math.min(o, c) * 0.99, close: c, volume: 1000 };
  });
}

const upIfAbove5: UserIndicator = { id: "ma", name: "站上 5 日線", typeId: "price_vs_ma", params: { period: 5, op: "gt" } };
const belowMa: UserIndicator = { id: "dn", name: "跌破 5 日線", typeId: "price_vs_ma", params: { period: 5, op: "lt" } };
const cfg: StrategyConfig = {
  ...DEFAULT_STRATEGY_CONFIG,
  buy: { ids: ["ma"], match: 0 },
  sell: { ids: ["dn"], match: 1 },
  stopLossPct: 0,
  takeProfitPct: 0,
  positionPct: 50,
  maxPositions: 2,
};

describe("策略回測", () => {
  it("訊號隔日開盤成交、淨值依收盤計算、不偷看未來", () => {
    // 前 40 天盤整 100，之後連續上漲；開盤價＝前一天收盤＋0.5
    const closes = [...Array.from({ length: 40 }, () => 100), ...Array.from({ length: 20 }, (_, i) => 101 + i)];
    const opens = closes.map((c, i) => (i === 0 ? c : closes[i - 1] + 0.5));
    const series = [{ symbol: "AAA", market: "TW" as const, name: "測試", candles: candles(closes, opens) }];
    const startDay = series[0].candles[35].time;
    const r = runBacktest({ cfg, indicators: [upIfAbove5, belowMa], series, bench: null, startDay, initialCash: 1_000_000 });
    const firstBuy = r.trades.find((t) => t.side === "buy")!;
    expect(firstBuy).toBeTruthy();
    // 第 40 根（101）收盤才站上 5 日線 → 第 41 根開盤成交，價格＝101＋0.5
    expect(firstBuy.day).toBe(series[0].candles[41].time);
    expect(firstBuy.price).toBe(101.5);
    expect(r.totalReturnPct).toBeGreaterThan(0);
    expect(r.curve.length).toBe(r.tradingDays);
    expect(r.openPositions.length).toBe(1);
  });

  it("下跌後跌破均線會賣出並記錄損益；回撤為負數", () => {
    const closes = [...Array.from({ length: 40 }, () => 100), ...Array.from({ length: 10 }, (_, i) => 101 + i * 2), ...Array.from({ length: 10 }, (_, i) => 118 - i * 3)];
    const series = [{ symbol: "BBB", market: "TW" as const, name: "測試2", candles: candles(closes) }];
    const r = runBacktest({ cfg, indicators: [upIfAbove5, belowMa], series, bench: null, startDay: series[0].candles[35].time, initialCash: 1_000_000 });
    expect(r.stats.sells).toBeGreaterThan(0);
    expect(r.trades.some((t) => t.side === "sell" && t.pnl != null)).toBe(true);
    expect(r.maxDrawdownPct).toBeLessThan(0);
  });

  it("對照 0050、資料太短的股票略過、沒有歷史的指標列出來", () => {
    const bench = candles(Array.from({ length: 60 }, (_, i) => 100 + i));
    const series = [
      { symbol: "CCC", market: "TW" as const, name: "c", candles: candles(Array.from({ length: 60 }, () => 50)) },
      { symbol: "DDD", market: "TW" as const, name: "d", candles: candles([1, 2, 3]) },
    ];
    const r = runBacktest({ cfg, indicators: [upIfAbove5, belowMa], series, bench, startDay: bench[40].time, initialCash: 100_000 });
    expect(r.skipped).toEqual(["DDD"]);
    expect(r.benchReturnPct).not.toBeNull();
    expect(r.benchReturnPct!).toBeGreaterThan(0);
    const chip: UserIndicator = { id: "c", name: "外資買超", typeId: "inst_streak", params: {} };
    expect(unsupportedIndicators({ ...cfg, buy: { ids: ["ma", "c"], match: 0 } }, [upIfAbove5, chip])).toEqual(["外資買超"]);
  });
});
