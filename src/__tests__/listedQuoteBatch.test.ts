import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Quote } from "@/lib/data/types";

const fetchBatch = vi.fn<(symbols: string[]) => Promise<Map<string, Quote>>>();
vi.mock("@/lib/data/twse", () => ({ fetchTwseQuotesBatch: (s: string[]) => fetchBatch(s) }));
vi.mock("@/lib/data/twOffHoursQuote", () => ({ reconcileTwListedQuoteMap: async (m: Map<string, Quote>) => m }));

import { getListedQuotesLive } from "@/lib/data/listedQuoteBatch";

const q = (symbol: string, price: number): Quote => ({
  symbol, market: "TW", name: symbol, price, change: 0, changePercent: 0, open: price, high: price, low: price,
  prevClose: price, volume: 1000, currency: "TWD", updatedAt: new Date().toISOString(),
});

beforeEach(() => {
  vi.useFakeTimers();
  fetchBatch.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("getListedQuotesLive：關注清單上市報價只抓指定幾檔", () => {
  it("只抓傳入的代號（去重、排序），不碰全市場", async () => {
    fetchBatch.mockResolvedValue(new Map([["2317", q("2317", 1)]]));
    const m = await getListedQuotesLive(["2330", "2317", "2330"]);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    expect(fetchBatch).toHaveBeenCalledWith(["2317", "2330"]);
    expect(m.get("2317")?.price).toBe(1);
  });

  it("10 秒內同一組代號共用結果；超過 10 秒（比 30 秒輪詢短）重新抓、拿到新值", async () => {
    fetchBatch.mockResolvedValueOnce(new Map([["1101", q("1101", 10)]])).mockResolvedValueOnce(new Map([["1101", q("1101", 11)]]));
    expect((await getListedQuotesLive(["1101"])).get("1101")?.price).toBe(10);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await getListedQuotesLive(["1101"])).get("1101")?.price).toBe(10);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await getListedQuotesLive(["1101"])).get("1101")?.price).toBe(11);
    expect(fetchBatch).toHaveBeenCalledTimes(2);
  });

  it("上游失敗（空結果）不快取，下一個請求立刻重試", async () => {
    fetchBatch.mockResolvedValueOnce(new Map()).mockResolvedValueOnce(new Map([["2002", q("2002", 20)]]));
    expect((await getListedQuotesLive(["2002"])).size).toBe(0);
    await Promise.resolve();
    expect((await getListedQuotesLive(["2002"])).get("2002")?.price).toBe(20);
    expect(fetchBatch).toHaveBeenCalledTimes(2);
  });

  it("上游丟例外 → 回空 Map（呼叫端退回單檔報價），同時進來的相同請求單飛", async () => {
    fetchBatch.mockRejectedValue(new Error("down"));
    const [a, b] = await Promise.all([getListedQuotesLive(["3008"]), getListedQuotesLive(["3008"])]);
    expect(a.size).toBe(0);
    expect(b.size).toBe(0);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
  });
});
