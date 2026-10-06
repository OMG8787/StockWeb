import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Quote } from "@/lib/data/types";

const getQuote = vi.fn<(symbol: string, market?: string) => Promise<Quote | null>>();
const listed = vi.fn<(symbols: string[]) => Promise<Map<string, Quote>>>();
vi.mock("@/lib/data/quote", () => ({ getQuote: (s: string, m?: string) => getQuote(s, m) }));
vi.mock("@/lib/data/listedQuoteBatch", () => ({ getListedQuotesLive: (s: string[]) => listed(s) }));
vi.mock("@/lib/data/universe", () => ({
  ensureTwUniverseWarm: async () => undefined,
  findInUniverse: (symbol: string) => (symbol === "9999" ? undefined : { symbol, sector: "測試業" }),
}));
vi.mock("@/lib/data/symbols", () => ({ resolveTwExchange: () => "TWSE" }));

import { getQuotesBatch } from "@/lib/data/quoteBatch";

const q = (symbol: string, price: number): Quote => ({
  symbol, market: "TW", name: symbol, price, change: 0, changePercent: 0, open: price, high: price, low: price,
  prevClose: price, volume: 1, currency: "TWD", updatedAt: new Date().toISOString(),
});

beforeEach(() => {
  vi.useFakeTimers();
  getQuote.mockReset();
  listed.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("getQuotesBatch：批次沒抓到的退回單檔，仍失敗的官方清單內股票再試一次", () => {
  it("批次缺的那檔退回單檔；單檔第一次失敗 → 1.1 秒後重試成功", async () => {
    listed.mockResolvedValue(new Map([["2330", q("2330", 100)]]));
    getQuote.mockResolvedValueOnce(null).mockResolvedValueOnce(q("6016", 23.9));
    const p = getQuotesBatch([{ market: "TW", symbol: "2330" }, { market: "TW", symbol: "6016" }]);
    await vi.advanceTimersByTimeAsync(1_200);
    const r = await p;
    expect(r[0]?.price).toBe(100);
    expect(r[0]?.sector).toBe("測試業");
    expect(r[1]?.price).toBe(23.9);
    expect(getQuote).toHaveBeenCalledTimes(2);
  });

  it("官方清單外的代號失敗 → 不重試（不白等）", async () => {
    listed.mockResolvedValue(new Map());
    getQuote.mockResolvedValue(null);
    const r = await getQuotesBatch([{ market: "TW", symbol: "9999" }]);
    expect(r[0]).toBeNull();
    expect(getQuote).toHaveBeenCalledTimes(1);
  });

  it("全部成功 → 不多等", async () => {
    listed.mockResolvedValue(new Map([["2330", q("2330", 100)]]));
    const r = await getQuotesBatch([{ market: "TW", symbol: "2330" }]);
    expect(r[0]?.price).toBe(100);
    expect(getQuote).not.toHaveBeenCalled();
  });
});
