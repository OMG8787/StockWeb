import { describe, expect, it } from "vitest";
import type { Candle, Quote } from "@/lib/data/types";
import { completedCandles, dayKeyInZone, overlayLiveCandle } from "@/lib/data/liveCandle";
import { computeIndicatorState, computeSignals } from "@/lib/signals";
import { latestRsi } from "@/lib/rsiFormula";

// 台北時間 2026-10-07（週三）11:30＝UTC 03:30
const NOW = new Date("2026-10-07T03:30:00Z");
const day = (i: number) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
function history(n: number, closeAt: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = closeAt(i);
    return { time: day(i), open: c, high: c + 1, low: c - 1, close: c, volume: 1000 };
  });
}
// 官方日K最後一根是 2026-10-06
const OFFICIAL = history(0, () => 0).concat(
  Array.from({ length: 70 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9, 6) - (69 - i) * 86400000).toISOString().slice(0, 10);
    const c = 100 + 10 * Math.sin(i / 4);
    return { time: d, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 };
  })
);
const quote = (over: Partial<Quote> = {}): Quote => ({
  symbol: "2330", market: "TW", name: "台積電", price: 120, change: 5, changePercent: 4.3, open: 116, high: 121, low: 115, prevClose: 115,
  volume: 500, currency: "TWD", updatedAt: NOW.toISOString(), tradeTime: "2026-10-07T03:29:50Z", ...over,
});

describe("overlayLiveCandle", () => {
  it("盤中、官方還沒有今天 → 補一根（開高低收量＝即時值、帶 live 標記）", () => {
    const out = overlayLiveCandle(OFFICIAL, quote(), { marketOpen: true, now: NOW });
    expect(out).toHaveLength(OFFICIAL.length + 1);
    expect(out.at(-1)).toEqual({ time: "2026-10-07", open: 116, high: 121, low: 115, close: 120, volume: 500, live: true });
    expect(OFFICIAL.at(-1)!.time).toBe("2026-10-06");
  });
  it("現價超出報價高低（報價時間差）→ 高低包住現價", () => {
    const c = overlayLiveCandle(OFFICIAL, quote({ price: 123 }), { marketOpen: true, now: NOW }).at(-1)!;
    expect(c.high).toBe(123);
    expect(c.close).toBe(123);
  });
  it("收盤後官方還沒公布 → 用最後成交價補（跟券商一致）", () => {
    const out = overlayLiveCandle(OFFICIAL, quote(), { marketOpen: false, now: new Date("2026-10-07T06:00:00Z") });
    expect(out.at(-1)!.live).toBe(true);
  });
  it("收盤後官方已有今天 → 不動（官方為準）", () => {
    const withToday = [...OFFICIAL, { time: "2026-10-07", open: 116, high: 121, low: 115, close: 119, volume: 9999 }];
    const out = overlayLiveCandle(withToday, quote(), { marketOpen: false, now: new Date("2026-10-07T07:00:00Z") });
    expect(out).toBe(withToday);
  });
  it("盤中官方已有今天 → 以即時值覆蓋（不重複）", () => {
    const withToday = [...OFFICIAL, { time: "2026-10-07", open: 116, high: 118, low: 115, close: 117, volume: 100 }];
    const out = overlayLiveCandle(withToday, quote(), { marketOpen: true, now: NOW });
    expect(out).toHaveLength(withToday.length);
    expect(out.at(-1)).toMatchObject({ close: 120, volume: 500, live: true });
  });
  it("不補：沒有報價、成交量 0（盤前試撮）、報價不是今天、興櫃、缺開盤價", () => {
    const o = { marketOpen: true, now: NOW };
    expect(overlayLiveCandle(OFFICIAL, null, o)).toBe(OFFICIAL);
    expect(overlayLiveCandle(OFFICIAL, quote({ volume: 0 }), o)).toBe(OFFICIAL);
    expect(overlayLiveCandle(OFFICIAL, quote({ tradeTime: "2026-10-06T05:30:00Z" }), o)).toBe(OFFICIAL);
    expect(overlayLiveCandle(OFFICIAL, quote({ tradeTime: undefined }), o)).toBe(OFFICIAL);
    expect(overlayLiveCandle(OFFICIAL, quote({ board: "emerging" }), o)).toBe(OFFICIAL);
    expect(overlayLiveCandle(OFFICIAL, quote({ open: null }), o)).toBe(OFFICIAL);
  });
  it("美股用紐約日期判斷今天", () => {
    const usNow = new Date("2026-10-07T15:00:00Z"); // 紐約 11:00
    const q = quote({ market: "US", symbol: "AAPL", tradeTime: "2026-10-07T14:59:00Z" });
    expect(overlayLiveCandle(OFFICIAL, q, { marketOpen: true, now: usNow }).at(-1)!.time).toBe("2026-10-07");
    expect(dayKeyInZone("2026-10-07T01:00:00Z", "America/New_York")).toBe("2026-10-06");
  });
  it("completedCandles 去掉 live 那根、沒有 live 時原樣回傳", () => {
    const out = overlayLiveCandle(OFFICIAL, quote(), { marketOpen: true, now: NOW });
    expect(completedCandles(out)).toEqual(OFFICIAL);
    expect(completedCandles(OFFICIAL)).toBe(OFFICIAL);
  });
});

describe("指標吃 live 那根（跟券商盤中一致），量能比排除它", () => {
  it("RSI／收盤序列：含今天即時價的 RSI＝用即時價當今天收盤獨立算出的值", () => {
    const withLive = overlayLiveCandle(OFFICIAL, quote({ price: 130, high: 131 }), { marketOpen: true, now: NOW });
    const expected = latestRsi([...OFFICIAL.map((c) => c.close), 130], 14);
    expect(computeIndicatorState(withLive, 130)!.rsi).toBeCloseTo(expected!, 10);
    expect(computeIndicatorState(OFFICIAL, 130)!.rsi).not.toBeCloseTo(expected!, 3);
  });
  it("量能比用已收盤的最後一根：盤中累計量很小也不會變成「量縮」", () => {
    const withLive = overlayLiveCandle(OFFICIAL, quote({ volume: 1 }), { marketOpen: true, now: NOW });
    const a = computeIndicatorState(OFFICIAL, 100)!.volumeRatio;
    const b = computeIndicatorState(withLive, 100)!.volumeRatio;
    expect(b).toBe(a);
    expect(computeSignals(withLive, 120, "3m").some((s) => s.label === "量縮")).toBe(false);
  });
});

import { computeRatingCore } from "@/lib/ai/ratingCore";
describe("評等：價位框架與追高防護不吃盤中補的今天這根（結論保護不變）", () => {
  const base = { symbol: "2330", name: "台積電", market: "TW" as const, asOfDay: "2026-10-07", chips: null, price: 112 };
  it("盤中跌到新低：價位框架與官方日K（不含今天）算出的完全相同", () => {
    const crash = quote({ price: 112, open: 118, high: 118, low: 111.5, changePercent: -2.6 });
    const withLive = overlayLiveCandle(OFFICIAL, crash, { marketOpen: true, now: NOW });
    const a = computeRatingCore({ ...base, candles: OFFICIAL });
    const b = computeRatingCore({ ...base, candles: withLive });
    expect(b.framework).toEqual(a.framework);
    expect(b.chase?.ret5).toBe(a.chase?.ret5);
  });
});
