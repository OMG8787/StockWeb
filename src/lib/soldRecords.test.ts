import { describe, expect, it } from "vitest";
import {
  applyAutoSellPrice,
  applyHoldingUpdate,
  applySaleConfirm,
  applySaleDelete,
  applySalePatch,
  hasSoldState,
  watchGroupOf,
  type WatchlistItem,
} from "./watchlist";
import {
  applySharesChange,
  chartRangeForDate,
  closeOnOrBefore,
  computeSaleMetrics,
  isSaleConfirmed,
  pickRatingAtSale,
  ratingWindowFor,
  saleVerdictOf,
  sanitizeSales,
  sortSalesNewestFirst,
  visibleSales,
} from "./soldRecords";
import { computeHoldingPnl } from "./portfolio";

const T0 = 1_000_000_000_000;
const base = (o: Partial<WatchlistItem> = {}): WatchlistItem[] => [
  { symbol: "2330", market: "TW", name: "台積電", shares: 1000, costBasis: 800, order: 0, ...o },
];
const ctx = (price: number | null, extra: { today?: string; now?: number } = {}) => ({ price, today: "2026-10-06", now: T0, ...extra });
const only = (l: WatchlistItem[]) => l[0];

describe("分組", () => {
  it("持有中／已賣出／未持有三組判定", () => {
    expect(watchGroupOf({ shares: 10, costBasis: 5 })).toBe("held");
    expect(watchGroupOf({ shares: 0, costBasis: 5, sales: [{ id: "a", date: "2026-10-01", shares: 1, remaining: 0 }] })).toBe("sold");
    expect(watchGroupOf({ shares: 0, costBasis: 5 })).toBe("unheld"); // 沒有賣出紀錄
    expect(watchGroupOf({})).toBe("unheld");
    expect(hasSoldState({ shares: 0, costBasis: 0, sales: [{ id: "a", date: "2026-10-01", shares: 1, remaining: 0 }] })).toBe(false);
  });
});

describe("股數歸零→已賣出", () => {
  it("全部賣出：保留購買價格、記下賣出價（現價）／日期／股數／買進價", () => {
    const next = applyHoldingUpdate(base(), "2330", "TW", { shares: 0, costBasis: 800 }, ctx(900));
    const it = only(next);
    expect(it.shares).toBe(0);
    expect(it.costBasis).toBe(800);
    expect(it.sales).toHaveLength(1);
    expect(it.sales![0]).toMatchObject({ date: "2026-10-06", shares: 1000, buyPrice: 800, sellPrice: 900, remaining: 0 });
    expect(watchGroupOf(it)).toBe("sold");
  });
  it("抓不到報價：賣出價留空", () => {
    const it = only(applyHoldingUpdate(base(), "2330", "TW", { shares: 0, costBasis: 800 }, ctx(null)));
    expect(it.sales![0].sellPrice).toBeUndefined();
  });
  it("價格也清掉→回到未持有，賣出紀錄保留但不顯示；價格填回去就再顯示", () => {
    let l = applyHoldingUpdate(base(), "2330", "TW", { shares: 0, costBasis: 800 }, ctx(900));
    l = applyHoldingUpdate(l, "2330", "TW", { shares: 0, costBasis: undefined }, ctx(900));
    expect(watchGroupOf(only(l))).toBe("unheld");
    expect(only(l).costBasis).toBeUndefined();
    expect(only(l).sales).toHaveLength(1);
    expect(visibleSales(only(l))).toHaveLength(0);
    l = applyHoldingUpdate(l, "2330", "TW", { shares: 0, costBasis: 700 }, ctx(900));
    expect(watchGroupOf(only(l))).toBe("sold");
    expect(visibleSales(only(l))).toHaveLength(1);
  });
  it("已賣出的股數再改成 >0 → 回到持有中，賣出紀錄保留", () => {
    let l = applyHoldingUpdate(base(), "2330", "TW", { shares: 0, costBasis: 800 }, ctx(900));
    l = applyHoldingUpdate(l, "2330", "TW", { shares: 200, costBasis: 800 }, ctx(950, { now: T0 + 3_600_000 }));
    expect(watchGroupOf(only(l))).toBe("held");
    expect(only(l).sales).toHaveLength(1);
  });
  it("股數空白＝整個清空（連價格），不記賣出", () => {
    const it = only(applyHoldingUpdate(base(), "2330", "TW", { shares: undefined, costBasis: 800 }, ctx(900)));
    expect(it.shares).toBeUndefined();
    expect(it.costBasis).toBeUndefined();
    expect(it.sales).toBeUndefined();
  });
  it("同組內改購買價格不動順序、不新增賣出紀錄", () => {
    const l = applyHoldingUpdate(base({ order: 5 }), "2330", "TW", { shares: 1000, costBasis: 810 }, ctx(900));
    expect(only(l).order).toBe(5);
    expect(only(l).sales).toBeUndefined();
  });
});

describe("部分賣出", () => {
  it("N 減到 M：新增一筆（N−M 股、remaining=M），股票留在持有中", () => {
    const it = only(applyHoldingUpdate(base(), "2330", "TW", { shares: 600, costBasis: 800 }, ctx(900)));
    expect(watchGroupOf(it)).toBe("held");
    expect(it.sales![0]).toMatchObject({ shares: 400, remaining: 600, sellPrice: 900 });
  });
  it("增加股數不記賣出", () => {
    expect(only(applyHoldingUpdate(base(), "2330", "TW", { shares: 1500, costBasis: 800 }, ctx(900))).sales).toBeUndefined();
  });
  it("一個數字一個數字刪（1000→100→10→1→0）合併成同一筆全部賣出", () => {
    let l = base();
    let t = T0;
    for (const n of [100, 10, 1, 0]) {
      l = applyHoldingUpdate(l, "2330", "TW", { shares: n, costBasis: 800 }, ctx(900, { now: (t += 1000) }));
    }
    expect(only(l).sales).toHaveLength(1);
    expect(only(l).sales![0]).toMatchObject({ shares: 1000, remaining: 0 });
  });
  it("先降再升回原股數：那一筆被拿掉", () => {
    let l = applyHoldingUpdate(base(), "2330", "TW", { shares: 0, costBasis: 800 }, ctx(900));
    l = applyHoldingUpdate(l, "2330", "TW", { shares: 1000, costBasis: 800 }, ctx(900, { now: T0 + 5000 }));
    expect(only(l).sales).toBeUndefined();
    expect(watchGroupOf(only(l))).toBe("held");
  });
  it("超過合併時間窗就是新的一筆", () => {
    let l = applyHoldingUpdate(base(), "2330", "TW", { shares: 600, costBasis: 800 }, ctx(900));
    l = applyHoldingUpdate(l, "2330", "TW", { shares: 300, costBasis: 800 }, ctx(910, { now: T0 + 60_000 }));
    expect(only(l).sales).toHaveLength(2);
    expect(only(l).sales![1]).toMatchObject({ shares: 300, remaining: 300, sellPrice: 910 });
  });
  it("使用者手動改過的紀錄不再被合併", () => {
    let l = applyHoldingUpdate(base(), "2330", "TW", { shares: 600, costBasis: 800 }, ctx(900));
    const id = only(l).sales![0].id;
    l = applySalePatch(l, "2330", "TW", id, { sellPrice: 905 });
    l = applyHoldingUpdate(l, "2330", "TW", { shares: 500, costBasis: 800 }, ctx(900, { now: T0 + 2000 }));
    expect(only(l).sales).toHaveLength(2);
    expect(only(l).sales![0]).toMatchObject({ shares: 400, sellPrice: 905 });
  });
});

describe("使用者改過的值以使用者為準", () => {
  const sold = () => applyHoldingUpdate(base(), "2330", "TW", { shares: 0, costBasis: 800 }, ctx(900));
  it("改欄位記為 user；自動重抓收盤價不會蓋掉 user 的賣出價", () => {
    let l = sold();
    const id = only(l).sales![0].id;
    l = applySalePatch(l, "2330", "TW", id, { sellPrice: 888 });
    expect(only(l).sales![0].user).toEqual(["sellPrice"]);
    const again = applyAutoSellPrice(l, "2330", "TW", id, 950, "2026-10-06");
    expect(again).toBe(l);
    expect(only(again).sales![0].sellPrice).toBe(888);
  });
  it("賣出價仍是 auto：改日期後自動收盤價可以寫入；日期已不是當初查的那天則作廢", () => {
    let l = sold();
    const id = only(l).sales![0].id;
    l = applySalePatch(l, "2330", "TW", id, { date: "2026-10-01" });
    expect(only(l).sales![0].user).toEqual(["date"]);
    const stale = applyAutoSellPrice(l, "2330", "TW", id, 950, "2026-09-30");
    expect(stale).toBe(l);
    const ok = applyAutoSellPrice(l, "2330", "TW", id, 950, "2026-10-01");
    expect(only(ok).sales![0].sellPrice).toBe(950);
    expect(isSaleConfirmed(only(ok).sales![0])).toBe(false);
  });
  it("確認狀態：按確認或四欄全改過才算已確認；沒賣出價不能按確認；清空賣出價就取消 user 標記", () => {
    let l = applyHoldingUpdate(base(), "2330", "TW", { shares: 0, costBasis: 800 }, ctx(null));
    const id = only(l).sales![0].id;
    expect(applySaleConfirm(l, "2330", "TW", id)).toBe(l);
    l = applySalePatch(l, "2330", "TW", id, { sellPrice: 900 });
    expect(isSaleConfirmed(only(l).sales![0])).toBe(false);
    const c = applySaleConfirm(l, "2330", "TW", id);
    expect(isSaleConfirmed(only(c).sales![0])).toBe(true);
    let all = l;
    all = applySalePatch(all, "2330", "TW", id, { date: "2026-10-02", shares: 900, buyPrice: 790 });
    expect(isSaleConfirmed(only(all).sales![0])).toBe(true);
    const cleared = applySalePatch(all, "2330", "TW", id, { sellPrice: null });
    expect(only(cleared).sales![0].sellPrice).toBeUndefined();
    expect(only(cleared).sales![0].user).not.toContain("sellPrice");
  });
  it("刪除一筆紀錄；刪光後 sales 欄位也移除", () => {
    const l = sold();
    const id = only(l).sales![0].id;
    const d = applySaleDelete(l, "2330", "TW", id);
    expect(only(d).sales).toBeUndefined();
    expect(applySaleDelete(l, "2330", "TW", "nope")).toBe(l);
  });
  it("不合格的日期／股數修改被忽略", () => {
    const l = sold();
    const id = only(l).sales![0].id;
    const p = applySalePatch(l, "2330", "TW", id, { date: "2026-13-40", shares: -5 });
    expect(only(p).sales![0]).toMatchObject({ date: "2026-10-06", shares: 1000 });
    expect(only(p).sales![0].user).toEqual([]);
  });
});

describe("損益口徑", () => {
  it("已實現損益＝跟持有中同一個 computeHoldingPnl（台股含手續費與證交稅）；若沒賣用現價同口徑", () => {
    const m = computeSaleMetrics({ date: "2026-10-01", shares: 1000, buyPrice: 800, sellPrice: 900 }, 950, "TW", "2026-10-06");
    const r = computeHoldingPnl(900, 800, 1000, "TW");
    const h = computeHoldingPnl(950, 800, 1000, "TW");
    expect(m.realizedPnl).toBe(r.pnl);
    expect(m.realizedPct).toBe(r.pnlPercent);
    expect(m.ifHeldPnl).toBe(h.pnl);
    expect(m.ifHeldPct).toBe(h.pnlPercent);
    expect(m.afterSellPct).toBeCloseTo((50 / 900) * 100, 10);
    expect(m.heldDiff).toBe(50_000);
    expect(m.verdict).toBe("early");
    expect(m.days).toBe(5);
  });
  it("賣出後下跌＝賣對了；缺價格不亂算", () => {
    const m = computeSaleMetrics({ date: "2026-10-01", shares: 10, buyPrice: 100, sellPrice: 120 }, 100, "US", "2026-10-01");
    expect(m.verdict).toBe("right");
    expect(m.realizedPnl).toBe(200);
    expect(m.days).toBe(0);
    const n = computeSaleMetrics({ date: "2026-10-01", shares: 10, buyPrice: 100 }, 100, "US", "2026-10-02");
    expect(n.realizedPnl).toBeNull();
    expect(n.afterSellPct).toBeNull();
    expect(n.verdict).toBeNull();
    expect(saleVerdictOf(0)).toBe("flat");
  });
});

describe("輔助", () => {
  it("評等：賣出日當天或之前最近一筆，同日取最後一筆", () => {
    const e = (symbol: string, day: string, at: string, h: string) => ({ symbol, day, at, label: "x", holdingLabel: h });
    const entries = [e("2330", "2026-10-05", "a", "續抱"), e("2330", "2026-10-06", "b", "減碼"), e("2330", "2026-10-06", "c", "出場"), e("2317", "2026-10-06", "z", "別檔"), e("2330", "2026-10-08", "d", "未來")];
    expect(pickRatingAtSale(entries, "2330", "2026-10-06")?.holdingLabel).toBe("出場");
    expect(pickRatingAtSale(entries, "2330", "2026-10-07")?.holdingLabel).toBe("出場");
    expect(pickRatingAtSale(entries, "2330", "2026-10-04")).toBeNull();
    expect(ratingWindowFor("2026-10-06")).toEqual({ from: "2026-10-05", to: "2026-10-06" });
  });
  it("日K：賣出日當天或之前最近收盤；太遠不冒用；日K範圍依天數", () => {
    const c = [{ time: "2026-09-28", close: 10 }, { time: "2026-09-29", close: 11 }, { time: "2026-10-02", close: 12 }];
    expect(closeOnOrBefore(c, "2026-10-03")).toEqual({ close: 12, day: "2026-10-02" });
    expect(closeOnOrBefore(c, "2026-09-29")?.close).toBe(11);
    expect(closeOnOrBefore(c, "2026-09-01")).toBeNull();
    expect(closeOnOrBefore(c, "2026-12-01")).toBeNull();
    expect(chartRangeForDate("2026-10-01", "2026-10-06")).toBe("1m");
    expect(chartRangeForDate("2026-06-01", "2026-10-06")).toBe("6m");
  });
  it("整理資料：丟掉壞資料、保留 user／confirmed；排序新到舊", () => {
    const s = sanitizeSales([{ id: "a", date: "2026-10-01", shares: 5, remaining: 0, user: ["sellPrice", "bogus"], confirmed: true }, { date: "bad", shares: 1 }, null, { date: "2026-10-01", shares: 0 }]);
    expect(s).toHaveLength(1);
    expect(s[0].user).toEqual(["sellPrice"]);
    expect(s[0].confirmed).toBe(true);
    expect(sortSalesNewestFirst([{ date: "2026-10-01" }, { date: "2026-10-03" }, { date: "2026-10-02" }]).map((x) => x.date)).toEqual(["2026-10-03", "2026-10-02", "2026-10-01"]);
    expect(applySharesChange({ shares: 10, costBasis: 5 }, 10, { today: "2026-10-06", now: 1 })).toEqual([]);
  });
});
