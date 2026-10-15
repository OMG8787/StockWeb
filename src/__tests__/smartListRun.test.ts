import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, setStoreForTests } from "@/lib/auth/store";
import type { Candle } from "@/lib/data/types";

/** 兩檔：UP 一路上漲（站上 5 日線）、DN 一路下跌 */
const series: Record<string, number[]> = {
  UP: Array.from({ length: 60 }, (_, i) => 100 + i),
  DN: Array.from({ length: 60 }, (_, i) => 200 - i),
};
function candles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ time: new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10), open: c, high: c, low: c, close: c, volume: 1000 }));
}

vi.mock("@/lib/data/universe", () => ({ ensureTwUniverseWarm: async () => {}, findInUniverse: () => undefined }));
vi.mock("@/lib/data", async (orig) => ({
  ...(await orig<object>()),
  searchStocks: async () => [
    { symbol: "UP", name: "漲", market: "TW", sector: "", price: 159, changePercent: 1, volume: 10, turnover: 2000 },
    { symbol: "DN", name: "跌", market: "TW", sector: "", price: 141, changePercent: -1, volume: 10, turnover: 1000 },
  ],
}));
vi.mock("@/lib/data/marketQuoteMap", () => ({ getMarketQuoteMap: async () => new Map() }));
vi.mock("@/lib/strategy/backtestData", () => ({ getBacktestCandles: async (s: string) => (series[s] ? candles(series[s]) : null) }));
vi.mock("@/lib/marketStatus", async (orig) => ({ ...(await orig<object>()), getMarketStatus: () => "closed" }));

const { saveIndicator, saveStrategy } = await import("@/lib/strategy/store");
const { runSmartList, getSmartList } = await import("@/lib/strategy/smartList");

const amy = { userId: "U1", account: "amy" };

describe("智能清單執行（假資料、真策略引擎）", () => {
  beforeEach(() => setStoreForTests(new MemoryStore()));
  afterEach(() => setStoreForTests(null));

  it("符合的加入、不符合的註明條件；資料反轉後保留並標示暫不符合", async () => {
    const ind = await saveIndicator(amy, { typeId: "price_vs_ma", name: "站上5日線", params: { period: 5, op: "gt" } });
    const st = await saveStrategy(amy, { name: "趨勢", config: { buy: { ids: [ind.id], match: 0 } } });
    const cfg = { enabled: true, strategyIds: [st.id], times: ["10:00", "13:40"] };
    const now = new Date("2026-10-15T02:05:00Z");
    const r = await runSmartList("U1", cfg, { slot: "10:00", slotKey: "2026-10-15|10:00", now });
    expect(r.data.entries.map((e) => [e.symbol, e.qualified, e.strategies])).toEqual([["UP", true, ["趨勢"]]]);
    expect(r.data.runs[0]).toMatchObject({ added: 1, slotKey: "2026-10-15|10:00" });

    // UP 反轉下跌：還在清單、標示不成立的條件
    series.UP = [...series.UP, ...Array.from({ length: 6 }, (_, i) => 150 - i * 5)];
    const r2 = await runSmartList("U1", cfg, { slot: "13:40", slotKey: "2026-10-15|13:40", now: new Date("2026-10-15T05:45:00Z") });
    const up = r2.data.entries.find((e) => e.symbol === "UP")!;
    expect(up.qualified).toBe(false);
    expect(up.failing[0]).toContain("趨勢：站上5日線");
    expect((await getSmartList("U1")).runs).toHaveLength(2);
  });
});
