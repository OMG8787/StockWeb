import { describe, expect, it } from "vitest";
import { applyBuyDateEdit, applyHoldingUpdate, normalizeBuyDate, type WatchlistItem } from "./watchlist";
import { buildWatchlistCsv, decodeWatchlistFile, encodeUtf16LeWithBom, parseWatchlistCsv } from "./watchlistCsv";
import { sanitizeSales } from "./soldRecords";

// 買進日（2026-10-06 使用者回報：國巨買進不到 10 天，AI 卻說買進後曾漲到 732）：
// 自動記錄、使用者改過不被覆蓋、買回重設、加碼不變、賣出紀錄保留、CSV 往返。
const T0 = 1_000_000_000_000;
const watch = (o: Partial<WatchlistItem> = {}): WatchlistItem[] => [{ symbol: "2327", market: "TW", name: "國巨", order: 0, ...o }];
const ctx = (today: string, now = T0, price: number | null = 700) => ({ price, today, now });
const first = (l: WatchlistItem[]) => l[0];

describe("買進日：自動記錄", () => {
  it("僅關注 → 填股數與購買價格變成持有中：記台北今天、來源 auto", () => {
    const step1 = applyHoldingUpdate(watch(), "2327", "TW", { shares: 1000 }, ctx("2026-09-27"));
    expect(first(step1).buyDate).toBeUndefined(); // 只有股數、還沒算持有
    const step2 = applyHoldingUpdate(step1, "2327", "TW", { shares: 1000, costBasis: 637 }, ctx("2026-09-27"));
    expect(first(step2)).toMatchObject({ buyDate: "2026-09-27", buyDateSrc: "auto" });
  });

  it("加碼（股數增加）、改價都不改買進日", () => {
    let l = applyHoldingUpdate(watch(), "2327", "TW", { shares: 1000, costBasis: 637 }, ctx("2026-09-27"));
    l = applyHoldingUpdate(l, "2327", "TW", { shares: 2000, costBasis: 640 }, ctx("2026-10-05"));
    expect(first(l)).toMatchObject({ shares: 2000, buyDate: "2026-09-27", buyDateSrc: "auto" });
  });

  it("使用者改過（user）：之後改股數、改價都不被自動覆蓋；部分賣出後仍持有也不動", () => {
    let l = applyHoldingUpdate(watch(), "2327", "TW", { shares: 1000, costBasis: 637 }, ctx("2026-10-06"));
    l = applyBuyDateEdit(l, "2327", "TW", "2026-09-27", "2026-10-06");
    expect(first(l)).toMatchObject({ buyDate: "2026-09-27", buyDateSrc: "user" });
    l = applyHoldingUpdate(l, "2327", "TW", { shares: 1500, costBasis: 650 }, ctx("2026-10-07"));
    l = applyHoldingUpdate(l, "2327", "TW", { shares: 500, costBasis: 650 }, ctx("2026-10-08", T0 + 999_999));
    expect(first(l)).toMatchObject({ shares: 500, buyDate: "2026-09-27", buyDateSrc: "user" });
  });

  it("買回：賣光（已賣出）後又填股數 → 新的一筆買進，日期重設為今天（auto）；賣出紀錄保留舊買進日", () => {
    let l = applyHoldingUpdate(watch(), "2327", "TW", { shares: 1000, costBasis: 637 }, ctx("2026-09-27"));
    l = applyBuyDateEdit(l, "2327", "TW", "2026-09-26", "2026-09-27");
    l = applyHoldingUpdate(l, "2327", "TW", { shares: 0, costBasis: 637 }, ctx("2026-10-01", T0));
    expect(first(l).sales).toHaveLength(1);
    expect(first(l).sales![0]).toMatchObject({ buyPrice: 637, buyDate: "2026-09-26", remaining: 0 });
    l = applyHoldingUpdate(l, "2327", "TW", { shares: 300, costBasis: 700 }, ctx("2026-10-06", T0 + 10 * 86_400_000));
    expect(first(l)).toMatchObject({ shares: 300, buyDate: "2026-10-06", buyDateSrc: "auto" });
    expect(first(l).sales![0].buyDate).toBe("2026-09-26");
  });

  it("30 秒內把剛賣出的改回去（連續編輯）不算買回，沿用原買進日", () => {
    let l = applyHoldingUpdate(watch(), "2327", "TW", { shares: 1000, costBasis: 637 }, ctx("2026-09-27"));
    l = applyHoldingUpdate(l, "2327", "TW", { shares: 0, costBasis: 637 }, ctx("2026-10-06", T0));
    l = applyHoldingUpdate(l, "2327", "TW", { shares: 1000, costBasis: 637 }, ctx("2026-10-06", T0 + 5_000));
    expect(first(l)).toMatchObject({ shares: 1000, buyDate: "2026-09-27", buyDateSrc: "auto" });
    expect(first(l).sales).toBeUndefined();
  });

  it("整檔清空回到僅關注：買進日清掉（再填是新的一筆）", () => {
    let l = applyHoldingUpdate(watch(), "2327", "TW", { shares: 1000, costBasis: 637 }, ctx("2026-09-27"));
    l = applyHoldingUpdate(l, "2327", "TW", {}, ctx("2026-10-01"));
    expect(first(l).buyDate).toBeUndefined();
    expect(first(l).buyDateSrc).toBeUndefined();
  });
});

describe("買進日：使用者編輯", () => {
  const held = () => applyHoldingUpdate(watch(), "2327", "TW", { shares: 1000, costBasis: 637 }, ctx("2026-10-06"));
  it("合格日期存成 user；清掉＝沒有買進日；未來日期、錯誤格式、非持有中都不接受", () => {
    const a = applyBuyDateEdit(held(), "2327", "TW", "2026-09-27", "2026-10-06");
    expect(first(a)).toMatchObject({ buyDate: "2026-09-27", buyDateSrc: "user" });
    expect(applyBuyDateEdit(a, "2327", "TW", "2026-10-07", "2026-10-06")).toBe(a);
    expect(applyBuyDateEdit(a, "2327", "TW", "2026/09/27", "2026-10-06")).toBe(a);
    expect(applyBuyDateEdit(watch(), "2327", "TW", "2026-09-27", "2026-10-06")).toEqual(watch());
    const cleared = applyBuyDateEdit(a, "2327", "TW", null, "2026-10-06");
    expect(first(cleared).buyDate).toBeUndefined();
    expect(first(cleared).buyDateSrc).toBeUndefined();
  });

  it("normalizeBuyDate：壞日期整組丟掉、沒來源當 user", () => {
    expect(normalizeBuyDate({ buyDate: "xx", buyDateSrc: "auto" as const })).toEqual({});
    expect(normalizeBuyDate({ buyDate: "2026-09-27" })).toEqual({ buyDate: "2026-09-27", buyDateSrc: "user" });
    expect(normalizeBuyDate({ buyDate: "2026-09-27", buyDateSrc: "auto" as const })).toEqual({ buyDate: "2026-09-27", buyDateSrc: "auto" });
  });

  it("sanitizeSales 保留合格的賣出買進日、丟掉壞的", () => {
    const rec = { id: "a", date: "2026-10-01", shares: 1, remaining: 0 };
    expect(sanitizeSales([{ ...rec, buyDate: "2026-09-26" }])[0].buyDate).toBe("2026-09-26");
    expect(sanitizeSales([{ ...rec, buyDate: "yesterday" }])[0].buyDate).toBeUndefined();
  });
});

describe("買進日：CSV 往返", () => {
  const roundTrip = (items: Parameters<typeof buildWatchlistCsv>[0]) => {
    const bytes = encodeUtf16LeWithBom(buildWatchlistCsv(items, {}));
    const dec = decodeWatchlistFile(bytes);
    if (!dec.ok) throw new Error(dec.error);
    const parsed = parseWatchlistCsv(dec.text);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed;
  };

  it("持有中的買進日與來源（估計／使用者）、賣出紀錄的買進日都能往返", () => {
    const items = [
      { market: "TW" as const, symbol: "2327", name: "國巨", shares: 1000, costBasis: 637, order: 0, buyDate: "2026-09-27", buyDateSrc: "auto" as const },
      { market: "TW" as const, symbol: "2330", name: "台積電", shares: 100, costBasis: 800, order: 1, buyDate: "2026-09-01", buyDateSrc: "user" as const },
      {
        market: "TW" as const, symbol: "2317", name: "鴻海", shares: 0, costBasis: 150, order: 2,
        sales: [{ id: "s1", date: "2026-10-01", shares: 1000, buyPrice: 150, buyDate: "2026-09-20", sellPrice: 160, remaining: 0 }],
      },
    ];
    const parsed = roundTrip(items);
    const by = (s: string) => parsed.items.find((i) => i.symbol === s)!;
    expect(by("2327")).toMatchObject({ buyDate: "2026-09-27", buyDateSrc: "auto" });
    expect(by("2330")).toMatchObject({ buyDate: "2026-09-01", buyDateSrc: "user" });
    expect(by("2317").sales![0].buyDate).toBe("2026-09-20");
    expect(by("2317").buyDate).toBeUndefined();
  });

  it("舊格式（沒有買進日欄位）仍能匯入，持有中沒有買進日", () => {
    const old = "市場\t代碼\t名稱\t持有股數\t購買價格\n台股\t2327\t國巨\t1000\t637\n";
    const parsed = parseWatchlistCsv(old);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.items[0]).toMatchObject({ symbol: "2327", shares: 1000, costBasis: 637 });
    expect(parsed.items[0].buyDate).toBeUndefined();
  });

  it("壞的買進日欄位值被忽略、不影響持股匯入", () => {
    const csv = "市場\t代碼\t名稱\t持有股數\t購買價格\t買進日期\t買進日期來源\n台股\t2327\t國巨\t1000\t637\t昨天\t估計\n";
    const parsed = parseWatchlistCsv(csv);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.items[0].shares).toBe(1000);
    expect(parsed.items[0].buyDate).toBeUndefined();
  });
});
