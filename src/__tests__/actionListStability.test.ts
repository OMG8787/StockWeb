/**
 * 今日建議名單穩定性整合測試（2026-10-06）：同樣的上游資料算兩次名單必須相同；
 * 某檔上游抓失敗（評等算不出來）或候選池變動時，「資料已定」時段上一份名單不會整份換掉。
 * 用 mock 上游跑正式的 buildActionGrounding（評等、評分、排序都是正式程式）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => {
  type C = { time: string; open: number; high: number; low: number; close: number; volume: number };
  /** up＝多頭拉回後轉強（評等建議買進）；down＝連跌＋法人賣超（先不要買）；flat＝漲幅榜上但體質弱 */
  const candles = (kind: "up" | "down" | "flat"): C[] => {
    const out: C[] = [];
    let p = 100;
    const start = Date.UTC(2026, 6, 1);
    let d = 0;
    for (let i = 0; i < 64; i++) {
      let t: Date;
      do {
        t = new Date(start + d++ * 86_400_000);
      } while (t.getUTCDay() === 0 || t.getUTCDay() === 6);
      const drift = kind === "up" ? (i < 58 ? 0.6 : i < 62 ? -0.8 : 1.2) : kind === "down" ? -0.7 : Math.sin(i / 3) * 0.4;
      const o = p;
      p = +(p + drift + Math.sin(i) * 0.3).toFixed(2);
      out.push({ time: t.toISOString().slice(0, 10), open: o, high: Math.max(o, p) + 0.5, low: Math.min(o, p) - 0.5, close: p, volume: 1_000_000 + (i === 63 ? 2_500_000 : 0) });
    }
    return out;
  };
  const kinds: Record<string, { name: string; kind: "up" | "down" | "flat"; inst: number }> = {
    "1111": { name: "測試多頭甲", kind: "up", inst: 3_000_000 },
    "1112": { name: "測試多頭乙", kind: "up", inst: 2_000_000 },
    "1113": { name: "測試多頭丙", kind: "up", inst: 1_000_000 },
    "1114": { name: "測試多頭丁", kind: "up", inst: 4_000_000 },
    "2222": { name: "測試空頭", kind: "down", inst: -3_000_000 },
  };
  /** 模擬上游失敗的代號（getQuote 回 null → 評等算不出來）與目前的候選池 */
  const state = { failing: new Set<string>(), pool: ["1111", "1112", "1113"] };
  const series = Object.fromEntries(Object.keys(kinds).map((s) => [s, candles(kinds[s].kind)]));
  const quote = (s: string) => {
    const k = kinds[s];
    if (!k) return null;
    const cs = series[s];
    const last = cs[cs.length - 1];
    const prev = cs[cs.length - 2].close;
    return {
      symbol: s, market: "TW", name: k.name, price: last.close, change: +(last.close - prev).toFixed(2),
      changePercent: +(((last.close - prev) / prev) * 100).toFixed(2), open: last.open, high: last.high, low: last.low,
      prevClose: prev, volume: last.volume, currency: "TWD", updatedAt: "2026-10-06T02:00:00Z",
    };
  };
  const chips = (s: string) => (kinds[s] ? { institutionalNetShares: kinds[s].inst, foreignNetShares: Math.round(kinds[s].inst * 0.6) } : null);
  return { kinds, series, quote, chips, state };
});

vi.mock("@/lib/data", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    getQuote: async (s: string) => (fx.state.failing.has(s.toUpperCase()) ? null : fx.quote(s.toUpperCase())),
    getChart: async (s: string) => (fx.series[s.toUpperCase()] ? { candles: fx.series[s.toUpperCase()] } : null),
    getChartLive: async (s: string) => (fx.series[s.toUpperCase()] ? { candles: fx.series[s.toUpperCase()] } : null),
    getChips: async (s: string) => fx.chips(s.toUpperCase()),
    getChipsRatios: async () => null,
    getChipsRatiosBatch: async () => new Map(),
    getFundamentals: async () => ({ peRatio: 10, dividendYield: 5 }),
    getEarnings: async () => ({ monthlyRevenueYoyPercent: 30 }),
    getMaterialAnnouncements: async () => [],
    findInUniverse: (s: string) => (fx.kinds[s] ? { symbol: s, name: fx.kinds[s].name, market: "TW", sector: "電子零組件業" } : undefined),
    getIndices: async () => [],
    getTaifexNightFutures: async () => null,
    getMacroSnapshot: async () => null,
    getMultiSignalStocks: async (m: string) =>
      m === "TW" ? fx.state.pool.map((s) => ({ ...fx.quote(s), signals: [] })) : [],
    // 排行／估值清單要非空：否則會被判為「輸入不完整」。內容只放 1111（已在候選池，不改變候選名單）
    getChipsRanking: async () => ({
      institutionalBuy: [{ ...fx.quote("1111"), netShares: 1000 }],
      institutionalSell: [], foreignBuy: [{ ...fx.quote("1111"), netShares: 1000 }], foreignSell: [], trustBuy: [],
    }),
    getValueScreen: async () => ({ lowPe: [{ ...fx.quote("1111"), peRatio: 10 }], highYield: [], lowPb: [], decliners: [] }),
    // 漲幅榜：3333 體質弱（會被挑成「不建議追」），1111 也在榜上（評等建議買進，不可被點名不建議追）
    searchStocks: async () => fx.state.pool.map((s) => ({ ...fx.quote(s), changePercent: 4, turnover: 500_000_000 })),
  };
});
vi.mock("@/lib/data/degradedCache", () => ({
  cachedWithDegradedNullTtl: async (_k: string, _a: number, _b: number, fn: () => Promise<unknown>) => fn(),
  cachedListWithDegradedEmptyTtl: async (_k: string, _a: number, _b: number, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/data/universe", () => ({
  ensureTwUniverseWarm: async () => {},
  findInUniverse: (s: string) => (fx.kinds[s] ? { symbol: s, name: fx.kinds[s].name, market: "TW", sector: "電子零組件業" } : undefined),
}));
vi.mock("@/lib/ai/learning/regimeData", () => ({
  getMarketRegime: async () => "range",
  // 3% < 弱市況門檻 5%：建議買進要附弱市況提示，各入口都要看到同一句
  getTaiexRet60Pct: async () => 3,
  getTaiexCandles: async () => [],
}));
vi.mock("@/lib/ai/grounding/sectorFactors", () => ({
  sectorFactorDirection: async () => null,
  describeSectorFactors: async () => undefined,
}));
vi.mock("@/lib/data/news", () => ({ dedupeNews: (x: unknown[]) => x, fetchNews: async () => [], fetchNewsMulti: async () => [] }));
vi.mock("@/lib/data/finnhub", () => ({ fetchFinnhubCompanyNews: async () => [] }));
vi.mock("@/lib/data/sentiment", () => ({ getUsStockSentiment: async () => null }));
vi.mock("@/lib/ai/grounding/history", () => ({ buildHistoryContext: async () => undefined }));
vi.mock("@/lib/ai/aiJudge", () => ({ getAiJudgment: async () => null, getAiJudgments: async () => new Map() }));
vi.mock("@/lib/ai/learning/experienceText", () => ({ describeExperience: async () => [] }));
vi.mock("@/lib/ai/newsfeed", () => ({ getNewsFeed: async () => ({ pinned: [], items: [], generatedAt: "" }) }));

import { buildActionGrounding } from "@/lib/ai/actionGrounding";
import type { StockRatingResult } from "@/lib/ai/stockRating";

const symbols = (g: Awaited<ReturnType<typeof buildActionGrounding>>) => g.picks.map((p) => p.rating.symbol);

beforeEach(() => {
  fx.state.failing = new Set();
  fx.state.pool = ["1111", "1112", "1113"];
});

describe("今日建議名單：相同輸入必得相同名單", () => {
  it("同一份上游資料連算兩次，名單（含順序）與輸入完整標記相同", async () => {
    const a = await buildActionGrounding();
    const b = await buildActionGrounding();
    expect(symbols(a)).toEqual(symbols(b));
    expect(symbols(a).length).toBeGreaterThanOrEqual(3);
    expect(a.degradedReasons).toEqual([]);
  });

  it("候選池來源順序不同、其餘資料相同，名單相同（同分以代號定序）", async () => {
    const a = await buildActionGrounding();
    fx.state.pool = ["1113", "1111", "1112"];
    const b = await buildActionGrounding();
    expect(new Set(symbols(b))).toEqual(new Set(symbols(a)));
  });
});

describe("今日建議名單：資料已定時段，上游失敗不會換掉整份名單", () => {
  it("某檔這次評等算不出來：有上一份名單就保留、並標示輸入不完整；沒有上一份名單才會缺", async () => {
    const first = await buildActionGrounding();
    const prev: StockRatingResult[] = first.picks.map((p) => p.rating);
    expect(symbols(first)).toContain("1112");

    fx.state.failing = new Set(["1112"]);
    const withoutPrev = await buildActionGrounding();
    expect(symbols(withoutPrev)).not.toContain("1112");
    expect(withoutPrev.degradedReasons.length).toBeGreaterThan(0);

    const withPrev = await buildActionGrounding({ previousPicks: prev });
    expect(new Set(symbols(withPrev))).toEqual(new Set(symbols(first)));
    expect(withPrev.degradedReasons.length).toBeGreaterThan(0);
    expect(withPrev.text).toContain("(1112)");
  });

  it("候選池整個變了（來源抓失敗只剩別檔）：上一份名單的股票仍留著、新股只補空位", async () => {
    const first = await buildActionGrounding();
    const prev = first.picks.map((p) => p.rating);
    fx.state.pool = ["1114"];
    const next = await buildActionGrounding({ previousPicks: prev });
    for (const s of symbols(first)) expect(symbols(next)).toContain(s);
    expect(symbols(next)).toContain("1114");
  });

  it("上一份名單的股票這次明確變成不建議買進（有評等、結論為先不要買）才會被換掉", async () => {
    const first = await buildActionGrounding();
    const prev = first.picks.map((p) => p.rating);
    // 把 1112 的歷史 K 線換成連跌＋法人賣超：模擬資料真的變了
    fx.kinds["1112"] = { name: "測試多頭乙", kind: "down", inst: -3_000_000 };
    fx.series["1112"] = fx.series["2222"];
    const next = await buildActionGrounding({ previousPicks: prev });
    expect(symbols(next)).not.toContain("1112");
    expect(symbols(next)).toContain("1111");
  });
});
