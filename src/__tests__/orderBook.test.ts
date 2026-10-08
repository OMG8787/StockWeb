import { describe, expect, it } from "vitest";
import { rowToOrderBook } from "@/lib/data/orderBook";
import { INDICATOR_TYPE_MAP } from "@/lib/strategy/indicatorCatalog";

describe("即時五檔", () => {
  it("解析 MIS 五檔（尾端底線、漲停鎖住另一側是 -）", () => {
    const b = rowToOrderBook({
      c: "2330", n: "台積電", z: "2550.0000", y: "2500.0000",
      b: "2550.0000_2545.0000_2540.0000_2535.0000_2530.0000_", g: "69_1314_957_748_723_",
      a: "2555.0000_2560.0000_", f: "140_235_",
    });
    expect(b.bids[0]).toEqual({ price: 2550, volume: 69 });
    expect(b.bids).toHaveLength(5);
    expect(b.asks).toEqual([{ price: 2555, volume: 140 }, { price: 2560, volume: 235 }]);
    expect([b.bidTotal, b.askTotal, b.price, b.prevClose]).toEqual([3811, 375, 2550, 2500]);
    const locked = rowToOrderBook({ c: "6148", a: "-", f: "-", b: "55.0000_", g: "9000_", z: "-", trade: { z: "55.0000" } });
    expect(locked.asks).toEqual([]);
    expect(locked.price).toBe(55);
  });

  it("指標：委買委賣力道；沒有五檔視為資料不足", () => {
    const t = INDICATOR_TYPE_MAP.get("order_book")!;
    const ctx = (bidTotal: number, askTotal: number) => ({ symbol: "2330", market: "TW" as const, candles: [], orderBook: { symbol: "2330", name: "", price: 1, prevClose: 1, bids: [], asks: [], bidTotal, askTotal } });
    expect(t.evaluate(ctx(300, 100), { side: "bid", ratio: 1.5 }).pass).toBe(true);
    expect(t.evaluate(ctx(120, 100), { side: "bid", ratio: 1.5 }).pass).toBe(false);
    expect(t.evaluate(ctx(100, 300), { side: "ask", ratio: 2 }).pass).toBe(true);
    expect(t.evaluate(ctx(500, 0), { side: "bid", ratio: 3 }).pass).toBe(true); // 漲停鎖住沒有賣單
    expect(t.evaluate({ symbol: "2330", market: "TW", candles: [] }, { side: "bid", ratio: 1.5 }).pass).toBeNull();
    expect(t.describe({ side: "bid", ratio: 1.5 })).toBe("五檔委買量是委賣量的 1.5 倍以上");
  });
});
