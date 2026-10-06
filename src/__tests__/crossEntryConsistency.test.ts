/**
 * 跨入口一致性整合測試（2026-10-06 整合稽核，CLAUDE.md「功能互通原則」）。
 *
 * mock 上游資料（報價、日K、籌碼、財報…），用正式程式跑：個股資料（個股問答／問AI關於）、今日建議名單、
 * 持股評等（輕量清單與深度分析共用）、評等紀錄 → 學習紀錄 → 看板統計、回測核心、時段判斷、市況門檻，
 * 驗證同一檔在各入口的結論字樣與價位逐字相同、紀錄欄位下游讀得到。資料流地圖見 docs/architecture/ai-pipeline.md。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

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
    "1111": { name: "測試多頭", kind: "up", inst: 3_000_000 },
    "2222": { name: "測試空頭", kind: "down", inst: -3_000_000 },
    "3333": { name: "測試急漲", kind: "flat", inst: -500_000 },
  };
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
  return { kinds, series, quote, chips };
});

vi.mock("@/lib/data", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    getQuote: async (s: string) => fx.quote(s.toUpperCase()),
    getChart: async (s: string) => (fx.series[s.toUpperCase()] ? { candles: fx.series[s.toUpperCase()] } : null),
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
      m === "TW" ? ["1111", "2222"].map((s) => ({ ...fx.quote(s), signals: [] })) : [],
    getChipsRanking: async () => ({ institutionalBuy: [], institutionalSell: [], foreignBuy: [], foreignSell: [], trustBuy: [] }),
    getValueScreen: async () => ({ lowPe: [], highYield: [], lowPb: [], decliners: [] }),
    // 漲幅榜：3333 體質弱（會被挑成「不建議追」），1111 也在榜上（評等建議買進，不可被點名不建議追）
    searchStocks: async () => ["3333", "1111"].map((s) => ({ ...fx.quote(s), changePercent: s === "3333" ? 9.5 : 4, turnover: 500_000_000 })),
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

import { getStockRating } from "@/lib/ai/stockRating";
import { buildStockGrounding } from "@/lib/ai/grounding/stock";
import { describePriceFramework } from "@/lib/ai/grounding/priceLevels";
import { buildActionGrounding } from "@/lib/ai/actionGrounding";
import { rateHoldings, buildHoldingsGrounding } from "@/lib/ai/grounding/holdings";
import { describeRatingForHolding } from "@/lib/ai/holdingRating";
import { describeSiteRating, isRecommendable, WEAK_MARKET_RET60_PCT } from "@/lib/ai/siteRating";
import { computeRatingCore } from "@/lib/ai/ratingCore";
import { buildRatingLogEntry, ratingLogField, ratingSession, type RatingLogEntry } from "@/lib/ai/ratingLog";
import { ratingLogToEval } from "@/lib/ai/learning/learningStore";
import { computeOutcome } from "@/lib/ai/learning/reward";
import { summarizeByCode } from "@/lib/ai/learning/summary";
import { getTwTradingPhase, taipeiDayKey } from "@/lib/pollingSchedule";
import { getMarketStatus } from "@/lib/marketStatus";
import { getTradingStance } from "@/lib/ai/tradingStance";
import { guardAvoidPriceAdvice } from "@/lib/ai/ratingConsistencyGuard";
import { REGIME_RET60_PCT } from "../../scripts/backtest/wideConfig";
import { REGIME_A_PCT } from "../../scripts/backtest/regimeConfig";

describe("同一檔股票：各入口結論與價位逐字相同", () => {
  it("fixture 前提：1111 建議買進、2222 先不要買", async () => {
    expect((await getStockRating("1111"))!.rating.code).toBe("buy");
    expect((await getStockRating("2222"))!.rating.code).toBe("avoid");
  });

  it("個股問答／問AI關於的個股資料＝評等行＋同一份價位框架", async () => {
    for (const sym of ["1111", "2222"]) {
      const r = (await getStockRating(sym))!;
      const g = (await buildStockGrounding({ symbol: sym, market: "TW" }))!;
      expect(g.text).toContain(describeSiteRating(r.name, r.symbol, r.rating));
      const levels = describePriceFramework(r.framework, { avoid: r.rating.code === "avoid" });
      if (levels) expect(g.text).toContain(levels);
    }
  });

  it("弱市況提示：評等、個股資料、今日建議同一句", async () => {
    const r = (await getStockRating("1111"))!;
    expect(r.rating.marketNote).toBeTruthy();
    const g = (await buildStockGrounding({ symbol: "1111", market: "TW" }))!;
    const ag = await buildActionGrounding();
    expect(g.text).toContain(r.rating.marketNote!);
    expect(ag.text).toContain(r.rating.marketNote!);
  });

  it("今日建議：名單評等行與個股資料相同、體檢表支持數＝評等支持數、不建議追不可是建議買進的股票", async () => {
    const r1 = (await getStockRating("1111"))!;
    const ag = await buildActionGrounding();
    expect(ag.picks.map((p) => p.rating.symbol)).toContain("1111");
    expect(ag.picks.map((p) => p.rating.symbol)).not.toContain("2222");
    expect(ag.text).toContain(describeSiteRating(r1.name, r1.symbol, r1.rating));
    expect(ag.text).toContain(`● ${r1.name}(1111)`);
    const block = ag.text.slice(ag.text.indexOf(`● ${r1.name}(1111)`)).split("\n●")[0];
    expect(block).toContain(`面向支持數：${r1.rating.supportCount}/`);
    if (ag.notChase) {
      const nr = await getStockRating(ag.notChase.symbol);
      expect(nr && isRecommendable(nr.rating)).toBeFalsy();
      expect(ag.notChase.symbol).not.toBe("1111");
    }
  });

  it("持股：未持有＝一般評等行；持有中＝輕量清單、深度分析（個股資料）同一個含成本結論", async () => {
    const r = (await getStockRating("1111"))!;
    const watch = await rateHoldings([{ symbol: "1111", market: "TW", name: r.name }]);
    expect(watch.get("1111")!.text).toBe(describeSiteRating(r.name, r.symbol, r.rating));

    const cost = 120;
    const held = await rateHoldings([{ symbol: "1111", market: "TW", name: r.name, costBasis: cost, shares: 1000 }]);
    const expected = describeRatingForHolding(r, { costBasis: cost, market: "TW", emerging: false }, fx.series["1111"]);
    expect(held.get("1111")!.text).toBe(expected.text);
    const light = await buildHoldingsGrounding([{ symbol: "1111", market: "TW", name: r.name, costBasis: cost, shares: 1000 }], false, true);
    expect(light).toContain(expected.text);
    const g = (await buildStockGrounding({ symbol: "1111", market: "TW" }, { costBasis: cost }))!;
    expect(g.text).toContain(expected.text);
  });

  it("回測核心＝正式評等（同一份輸入逐值相同）", async () => {
    for (const sym of ["1111", "2222", "3333"]) {
      const r = (await getStockRating(sym))!;
      const cs = fx.series[sym];
      const core = computeRatingCore({
        symbol: sym, name: r.name, price: r.price, market: "TW", candles: cs, asOfDay: taipeiDayKey(),
        chips: fx.chips(sym) as never, fundamentals: { peRatio: 10, dividendYield: 5 } as never,
        earnings: { monthlyRevenueYoyPercent: 30 } as never, marketRet60Pct: 3,
      });
      expect(core.rating).toEqual(r.rating);
      expect(core.framework).toEqual(r.framework);
    }
  });

  it("先不要買的股票：回答裡的出場價／買進區間會被回答後檢查刪掉（以個股資料為準）", async () => {
    const r = (await getStockRating("2222"))!;
    const g = (await buildStockGrounding({ symbol: "2222", market: "TW" }))!;
    const out = guardAvoidPriceAdvice(`${r.name}(2222)目前建議先不要買。若要買可在 50～52 買進，跌破 48 出場。`, g.text);
    expect(out.fixes.length).toBeGreaterThan(0);
    expect(out.text).not.toMatch(/跌破 48 出場/);
  });
});

describe("評等紀錄 → 學習工作 → 看板：欄位對得上（含舊紀錄）", () => {
  it("正式評等寫成的紀錄，學習工作讀得到並能算獎勵、看板能彙整", async () => {
    const r = (await getStockRating("1111"))!;
    const now = new Date("2026-10-06T02:00:00Z");
    const entry = buildRatingLogEntry(r, "today-brief", now);
    expect(ratingLogField(entry.symbol, entry.code)).toBe("1111#buy");
    expect(entry.session).toBe(ratingSession(getTwTradingPhase(now)));
    const ev = ratingLogToEval(entry, undefined);
    expect(ev).toMatchObject({ sym: "1111", code: r.rating.code, price: r.price, day: entry.day, rg: "range" });
    expect(ev.bases.length).toBeGreaterThan(0);
    expect(ev.f).toEqual(r.features);
    const after = fx.series["1111"].map((c, i) => ({ ...c, time: `2026-10-${String(7 + i).padStart(2, "0")}` })).slice(0, 25);
    const o5 = computeOutcome({ code: ev.code, price: ev.price, day: ev.day, preOpen: false }, after, after, 5);
    expect(o5).not.toBeNull();
    const stats = summarizeByCode([{ ...ev, o: { "5": o5! } }]);
    expect(stats.some((s) => s.code === "buy")).toBe(true);
  });

  it("舊紀錄（沒有 feat／rg／ai、舊結論等回檔）也讀得進學習紀錄", () => {
    const old = {
      at: "2026-10-05T03:00:00Z", day: "2026-10-05", session: "盤中", symbol: "2330", name: "台積電", market: "TW", price: 1000,
      code: "buy-on-pullback", label: "建議等回檔再買", holdingLabel: "續抱", reason: "舊", facets: { 技術面: "支持", 籌碼面: "中性" },
      zone: null, noChase: null, exit: null, chaseHits: [], source: "ai-ask",
    } as RatingLogEntry;
    const ev = ratingLogToEval(old, undefined);
    expect(ev).toMatchObject({ sym: "2330", code: "buy-on-pullback", rg: null, sk: null });
    expect(ev.bases.length).toBeGreaterThan(0);
  });
});

describe("時段與市況：全站同一組定義", () => {
  it("交易時段、盤中徽章、AI 立場、評等紀錄時段在一週每分鐘都一致", () => {
    // 2026-10-05（一）00:00 台北 ～ 2026-10-11（日）23:59，每 5 分鐘
    const start = Date.UTC(2026, 9, 4, 16, 0);
    for (let m = 0; m < 7 * 24 * 60; m += 5) {
      const now = new Date(start + m * 60_000);
      const phase = getTwTradingPhase(now);
      const status = getMarketStatus("TW", now);
      expect(phase === "intraday").toBe(status === "open");
      if (status === "pre-market") expect(phase).toBe("pre-open");
      const stance = getTradingStance(now);
      expect(stance.phase).toBe(phase);
      expect(stance.briefMode === "next-open").toBe(phase === "after-close" || phase === "weekend");
      const session = ratingSession(phase);
      expect(session === "盤中").toBe(phase === "intraday");
    }
  });

  it("弱市況門檻：正式站與兩支回測同一個常數", () => {
    expect(REGIME_RET60_PCT).toBe(WEAK_MARKET_RET60_PCT);
    expect(REGIME_A_PCT).toBe(WEAK_MARKET_RET60_PCT);
  });
});

describe("結構性守門：唯一來源不可被繞過", () => {
  const roots = ["src", "scripts"];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__" && e.name !== "node_modules") walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  roots.forEach((r) => walk(path.resolve(process.cwd(), r)));
  const callers = (re: RegExp) =>
    files.filter((f) => re.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(process.cwd(), f).replace(/\\/g, "/")).sort();

  it("computeSiteRating 只能由 ratingCore.ts 呼叫（正式站與回測共用同一個核心）", () => {
    expect(callers(/computeSiteRating\(/)).toEqual(["src/lib/ai/ratingCore.ts", "src/lib/ai/siteRating.ts"]);
  });
  it("computePriceFramework 只能由 ratingCore.ts 呼叫（興櫃規則與日K長度只有一處）", () => {
    expect(callers(/computePriceFramework\(/)).toEqual(["src/lib/ai/grounding/priceLevels.ts", "src/lib/ai/ratingCore.ts"]);
  });
  it("評等紀錄 field 只能由 ratingLogField 產生", () => {
    expect(callers(/`\$\{[^}]*symbol[^}]*\}#\$\{[^}]*code[^}]*\}`/)).toEqual(["src/lib/ai/ratingLog.ts"]);
  });
  it("AI 問答回答後處理只有 finalizeAiAnswer（內部呼叫 postProcessAiAnswer）一個入口", () => {
    const ask = fs.readFileSync(path.resolve(process.cwd(), "src/lib/ai/ask.ts"), "utf8");
    expect(ask).toMatch(/finalizeAiAnswer\(\{\s*raw: result\.answer,/);
    expect(ask).toMatch(/const first = postProcessAiAnswer\(input\.raw, input\.grounding\)/);
    expect(ask).toMatch(/const second = postProcessAiAnswer\(retryRaw, input\.grounding\)/);
  });
});
