import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/data/types";
import { normalizeStrategyConfig, type UserIndicator } from "@/lib/strategy/engine";
import { consensusBuy, ratingSignal, strategySignalSeries } from "@/lib/strategy/history";

const candles = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ time: `2026-01-${String(i + 1).padStart(2, "0")}`, open: c, high: c, low: c, close: c, volume: 1000 }));

describe("策略逐日訊號", () => {
  const ind: UserIndicator[] = [{ id: "up", name: "收盤站上5日線", typeId: "price_vs_ma", params: { period: 5, op: "gt" } }];
  const cfg = normalizeStrategyConfig({ buy: { ids: ["up"], match: 0 } }, new Set(["up"]));

  it("每天只用截到那天的日K（不看未來），長度與天數對齊", () => {
    // 前 10 天下跌、後 5 天大漲：下跌段不會因為後面上漲而變成買進
    const closes = [...Array.from({ length: 10 }, (_, i) => 100 - i), 120, 125, 130, 135, 140];
    const { signals, latest } = strategySignalSeries(cfg, ind, { symbol: "X", market: "TW", candles: candles(closes) }, 8);
    expect(signals).toHaveLength(8);
    expect(signals.slice(0, 3)).toEqual([null, null, null]); // 第 8～10 天仍在下跌
    expect(signals.slice(3)).toEqual(["buy", "buy", "buy", "buy", "buy"]);
    expect(latest.buy).toBe(true);
  });

  it("共識：每個策略同一天都是買進才算", () => {
    expect(consensusBuy([["buy", "buy", null], ["buy", "sell", "buy"]])).toEqual([true, false, false]);
    expect(consensusBuy([])).toEqual([]);
  });

  it("本站評等轉訊號", () => {
    expect(ratingSignal("buy-on-pullback")).toBe("buy");
    expect(ratingSignal("avoid")).toBe("sell");
    expect(ratingSignal(undefined)).toBeNull();
  });
});
