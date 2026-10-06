import { describe, expect, it } from "vitest";
import {
  buildWatchlistCsv,
  decodeWatchlistFile,
  encodeUtf16LeWithBom,
  parseWatchlistCsv,
  CSV_MAX_ROWS,
  type ParsedWatchlistCsv,
  type WatchlistExportItem,
} from "./watchlistCsv";
import { mergeWatchlists } from "./watchlistImport";
import type { WatchlistItem } from "./watchlist";

const items: WatchlistExportItem[] = [
  { market: "TW", symbol: "2330", name: "台積電", price: 900, volume: 1000, changePercent: 1.2, shares: 1000, costBasis: 800, order: 1 },
  { market: "US", symbol: "AAPL", name: "Apple", price: 200, shares: 5.5, costBasis: 150.25, order: 0 },
  { market: "TW", symbol: "2317", name: "鴻海", price: 100, order: 3 },
  { market: "TW", symbol: "00878", name: "國泰永續高股息", price: 22, order: 0 },
  { market: "US", symbol: "NVDA", name: 'Say "hi"', price: null, order: 2 },
  { market: "US", symbol: "TSLA", name: "Tesla" },
];

function roundTrip(text: string, flags = {}): ParsedWatchlistCsv {
  const bytes = encodeUtf16LeWithBom(text);
  const dec = decodeWatchlistFile(bytes);
  expect(dec.ok).toBe(true);
  const r = parseWatchlistCsv((dec as { text: string }).text);
  expect(r.ok).toBe(true);
  void flags;
  return r as ParsedWatchlistCsv & { ok: true };
}

describe("匯出編碼", () => {
  it("開頭是 FF FE，且 UTF-16LE 解回原字串", () => {
    const text = buildWatchlistCsv(items, {});
    const bytes = encodeUtf16LeWithBom(text);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xfe);
    expect(new TextDecoder("utf-16le").decode(bytes.subarray(2))).toBe(text);
  });
  it("Tab 分隔、每列欄位數一致、欄內 Tab／換行被換成空白", () => {
    const text = buildWatchlistCsv([{ ...items[0], name: "a\tb\nc" }, items[1]], {});
    const lines = text.split("\r\n");
    expect(lines).toHaveLength(3);
    expect(new Set(lines.map((l) => l.split("\t").length)).size).toBe(1);
    expect(lines[1]).toContain("a b c");
  });
});

describe("往返", () => {
  it("新版 UTF-16LE 匯出→匯入後資料完全相同（含順序、手動排序旗標）", () => {
    const flags = { TW: true };
    const r = roundTrip(buildWatchlistCsv(items, flags));
    expect(r.version).toBe("v3");
    expect(r.invalid).toEqual([]);
    expect(r.manualUnheld).toEqual({ TW: true });
    const expected: WatchlistItem[] = items.map((i) => {
      const o: WatchlistItem = { market: i.market, symbol: i.symbol, name: i.name };
      if (i.shares != null) { o.shares = i.shares; o.costBasis = i.costBasis; }
      if (i.order != null) o.order = i.order;
      return o;
    });
    expect(r.items).toEqual(expected);
  });
  it("UTF-8 有／無 BOM 的 Tab 檔也能讀", () => {
    const text = buildWatchlistCsv(items, {});
    for (const withBom of [true, false]) {
      const b = new TextEncoder().encode((withBom ? "﻿" : "") + text);
      const d = decodeWatchlistFile(b);
      expect(d.ok).toBe(true);
      const r = parseWatchlistCsv((d as { text: string }).text);
      expect(r.ok && r.items.length).toBe(items.length);
    }
  });
});

describe("舊版 UTF-8 逗號 CSV", () => {
  const legacy =
    "﻿" +
    [
      '"市場","代碼","名稱","成交量","股價","漲跌幅(%)","狀態","持有股數","購買價格","損益平衡價","投資金額","損益","損益(%)"',
      '"台股","2330","台積電","1000","900","1.2","持有中","1000","800","801","800000","99000","12"',
      '"美股","AAPL","Apple","","200","0.5","持有中","5.5","150.25","","826","270","32"',
      '"台股","2317","鴻海","","100","0","僅關注","","","","","",""',
      '"台股","1101","台泥","","30","0","僅關注","","","","","",""',
    ].join("\r\n");
  it("還原代號、名稱、持股，順序依檔案列序", () => {
    const d = decodeWatchlistFile(new TextEncoder().encode(legacy));
    const r = parseWatchlistCsv((d as { text: string }).text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.version).toBe("legacy");
    expect(r.items).toEqual([
      { market: "TW", symbol: "2330", name: "台積電", shares: 1000, costBasis: 800, order: 0 },
      { market: "US", symbol: "AAPL", name: "Apple", shares: 5.5, costBasis: 150.25, order: 1 },
      { market: "TW", symbol: "2317", name: "鴻海", order: 0 },
      { market: "TW", symbol: "1101", name: "台泥", order: 1 },
    ]);
    expect(r.manualUnheld).toEqual({ TW: true });
  });
  it("沒有「市場」欄時用代碼判斷；分號分隔＋小數逗號", () => {
    const r = parseWatchlistCsv("代碼;名稱;持有股數;購買價格\n2330;台積電;10;800,5\nmsft;Microsoft;;");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items[0]).toMatchObject({ market: "TW", symbol: "2330", shares: 10, costBasis: 800.5 });
    expect(r.items[1]).toMatchObject({ market: "US", symbol: "MSFT" });
  });
});

describe("壞資料", () => {
  it("壞列被列出原因、數字欄非數字當空白、重複代碼以後者為準", () => {
    const r = parseWatchlistCsv(
      ["代碼,名稱,持有股數,購買價格", "2330,台積電,abc,xyz", "<script>,x,,", "878,Excel吃0,,", ",空,,", "2330,台積電2,5,100"].join("\n")
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ name: "台積電2", shares: 5, costBasis: 100 });
    expect(r.invalid.map((x) => x.line)).toEqual([3, 4, 5]);
    expect(r.invalid[1].reason).toContain("前導 0");
    expect(r.warnings.some((w) => w.reason.includes("重複"))).toBe(true);
  });
  it("只有股數沒有成本 → 僅關注＋提醒", () => {
    const r = parseWatchlistCsv("代碼,名稱,持有股數,購買價格\n2330,台積電,10,");
    expect(r.ok && r.items[0].shares).toBeUndefined();
    expect(r.ok && r.warnings).toHaveLength(1);
  });
  it("沒有代碼欄／空檔／超過列數上限", () => {
    expect(parseWatchlistCsv("a,b\n1,2").ok).toBe(false);
    expect(parseWatchlistCsv("").ok).toBe(false);
    const many = ["代碼,名稱", ...Array.from({ length: CSV_MAX_ROWS + 1 }, (_, i) => `${1000 + i},x`)].join("\n");
    expect(parseWatchlistCsv(many).ok).toBe(false);
  });
  it("檔案超過 500KB 被擋", () => {
    expect(decodeWatchlistFile(new Uint8Array(501 * 1024)).ok).toBe(false);
  });
  it("Big5 位元組被偵測並提示", () => {
    // 「代碼」的 Big5：A5 N A5 58 ... 不是合法 UTF-8
    const bytes = new Uint8Array([0xa5, 0xa3, 0xbd, 0x58, 0x2c, 0xa6, 0x57, 0xba, 0xd9]);
    const d = decodeWatchlistFile(bytes);
    expect(d.ok).toBe(false);
    expect(!d.ok && d.error).toContain("UTF-8");
  });
});

describe("合併", () => {
  it("相同代碼以匯入為準、位置沿用，新代碼排到該組最後", () => {
    const cur: WatchlistItem[] = [
      { market: "TW", symbol: "2330", name: "台積電", order: 0 },
      { market: "TW", symbol: "2317", name: "鴻海", order: 1 },
    ];
    const imp: WatchlistItem[] = [
      { market: "TW", symbol: "2317", name: "鴻海", shares: 10, costBasis: 100, order: 5 },
      { market: "TW", symbol: "1101", name: "台泥", order: 9 },
      { market: "US", symbol: "AAPL", name: "Apple", order: 0 },
    ];
    const m = mergeWatchlists(cur, imp);
    expect(m.map((i) => i.symbol)).toEqual(["2330", "2317", "AAPL", "1101"]);
    expect(m[1]).toMatchObject({ shares: 10, costBasis: 100, order: 0 }); // 換到持有組，排在持有組最後
    expect(m[2].order).toBe(0);
    expect(m[3].order).toBe(1);
  });
});

describe("已賣出（v3）往返", () => {
  const sold: WatchlistExportItem[] = [
    {
      market: "TW", symbol: "2330", name: "台積電", price: 950, shares: 0, costBasis: 800, order: 0,
      sales: [
        { id: "a", date: "2026-10-01", shares: 1000, buyPrice: 800, sellPrice: 900, remaining: 0, user: ["sellPrice", "date"], confirmed: true },
        { id: "b", date: "2026-10-03", shares: 200, buyPrice: 790, remaining: 0 },
      ],
    },
    { market: "US", symbol: "AAPL", name: "Apple", price: 200, shares: 50, costBasis: 150, order: 1, sales: [{ id: "c", date: "2026-10-02", shares: 5.5, buyPrice: 150, sellPrice: 190, remaining: 50, user: [] }] },
    { market: "TW", symbol: "2317", name: "鴻海", order: 2, sales: [{ id: "d", date: "2026-09-30", shares: 10, buyPrice: 100, sellPrice: 120, remaining: 0, user: ["日期" as never].slice(0, 0) }] },
  ];
  const strip = (l: WatchlistItem[]) =>
    l.map((i) => ({ ...i, sales: i.sales?.map(({ id, ...rest }) => { void id; return { ...rest, user: rest.user ?? [] }; }) }));
  it("賣出紀錄（含 user 欄位標記、已確認、部分賣出、價格已清掉的未持有檔）完整往返", () => {
    const r = roundTrip(buildWatchlistCsv(sold, {}));
    expect(r.invalid).toEqual([]);
    expect(r.version).toBe("v3");
    const got = strip(r.items);
    expect(got[0]).toMatchObject({ symbol: "2330", shares: 0, costBasis: 800 });
    expect(got[0].sales).toEqual([
      { date: "2026-10-01", shares: 1000, buyPrice: 800, sellPrice: 900, remaining: 0, user: ["date", "sellPrice"], confirmed: true, autoAt: undefined },
      { date: "2026-10-03", shares: 200, buyPrice: 790, sellPrice: undefined, remaining: 0, user: [], confirmed: undefined, autoAt: undefined },
    ]);
    expect(got[1].sales![0]).toMatchObject({ shares: 5.5, remaining: 50, sellPrice: 190 });
    expect(got[2].shares).toBeUndefined();
    expect(got[2].sales).toHaveLength(1);
  });
  it("已賣出那一列的狀態是「已賣出」，賣出紀錄各占一列", () => {
    const lines = buildWatchlistCsv(sold, {}).split(String.fromCharCode(13, 10));
    expect(lines).toHaveLength(1 + 3 + 4);
    expect(lines.filter((l) => l.includes("	已賣出	"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("	賣出紀錄	"))).toHaveLength(4);
    expect(new Set(lines.map((l) => l.split(String.fromCharCode(9)).length)).size).toBe(1);
  });
  it("舊格式（v2／舊版）匯入不會有賣出紀錄", () => {
    const v2 = ["市場	代碼	名稱	狀態	持有股數	購買價格	格式版本	清單順序", "台股	2330	台積電	持有中	10	800	v2	0"].join(String.fromCharCode(10));
    const r = parseWatchlistCsv(v2);
    expect(r.ok && r.version).toBe("v2");
    expect(r.ok && r.items[0].sales).toBeUndefined();
  });
  it("壞的賣出紀錄列（日期不對）被列為無法辨識", () => {
    const text = buildWatchlistCsv(sold, {}).replace("2026-10-01", "2026/10/01");
    const r = parseWatchlistCsv(text);
    expect(r.ok && r.invalid).toHaveLength(1);
  });
});
