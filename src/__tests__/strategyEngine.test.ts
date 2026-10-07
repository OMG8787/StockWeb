import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/data/types";
import { INDICATOR_TYPES, evaluateIndicator, normalizeParams, type EvalContext } from "@/lib/strategy/indicatorCatalog";
import {
  applyBuy,
  applySell,
  evaluateStrategy,
  normalizeStrategyConfig,
  runSimDay,
  simEquity,
  type Candidate,
  type SimState,
  type StrategyConfig,
  type UserIndicator,
} from "@/lib/strategy/engine";

/** 由收盤價序列產生日K（高低開＝收盤附近；量固定，最後一根可指定） */
function candles(closes: number[], lastVolume = 1000): Candle[] {
  return closes.map((c, i) => ({
    time: `2026-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
    open: c,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume: i === closes.length - 1 ? lastVolume : 1000,
  }));
}
const ctxOf = (closes: number[], extra: Partial<EvalContext> = {}): EvalContext => ({
  symbol: "2330",
  market: "TW",
  candles: candles(closes),
  ...extra,
});
const range = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

describe("參考指標", () => {
  it("每個指標都有說明、參數預設值合法、describe 不會壞", () => {
    for (const t of INDICATOR_TYPES) {
      const p = normalizeParams(t.id, {});
      expect(t.describe(p).length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThan(5);
    }
  });

  it("參數會被夾在範圍內、選項不對用預設", () => {
    expect(normalizeParams("rsi", { period: 999, op: "xx", value: -5 })).toEqual({ period: 60, op: "lt", value: 0 });
    expect(() => normalizeParams("nope", {})).toThrow();
  });

  it("RSI：連跌時低於 30、連漲時高於 70", () => {
    const down = ctxOf(range(40, (i) => 100 - i));
    const up = ctxOf(range(40, (i) => 100 + i));
    expect(evaluateIndicator("rsi", { period: 14, op: "lt", value: 30 }, down).pass).toBe(true);
    expect(evaluateIndicator("rsi", { period: 14, op: "gt", value: 70 }, up).pass).toBe(true);
    expect(evaluateIndicator("rsi", { period: 14, op: "lt", value: 30 }, up).pass).toBe(false);
  });

  it("均線黃金交叉：先跌後急漲，5 日線剛穿越 20 日線", () => {
    const closes = [...range(40, (i) => 100 - i * 0.5), ...range(4, (i) => 82 + i * 6)];
    const ctx = ctxOf(closes);
    const r = evaluateIndicator("ma_cross", { short: 5, long: 20, dir: "golden", within: 5 }, ctx);
    expect(r.pass).toBe(true);
    expect(evaluateIndicator("ma_cross", { short: 5, long: 20, dir: "dead", within: 5 }, ctx).pass).toBe(false);
  });

  it("成交量放大、突破新高、N 日漲跌幅", () => {
    const ctx: EvalContext = { symbol: "2330", market: "TW", candles: candles([...range(30, () => 100), 110], 5000) };
    expect(evaluateIndicator("volume_surge", { period: 20, multiple: 2 }, ctx).pass).toBe(true);
    expect(evaluateIndicator("breakout", { days: 20, dir: "high" }, ctx).pass).toBe(true);
    expect(evaluateIndicator("price_change", { days: 1, op: "gt", pct: 9 }, ctx).pass).toBe(true);
  });

  it("資料不足回 null；美股遇到台股限定指標回不適用", () => {
    expect(evaluateIndicator("rsi", { period: 14, op: "lt", value: 30 }, ctxOf([100, 101])).pass).toBeNull();
    const us: EvalContext = { symbol: "AAPL", market: "US", candles: [] };
    expect(evaluateIndicator("inst_streak", { who: "foreign", dir: "buy", days: 3 }, us)).toEqual({ pass: null, detail: "只適用台股" });
  });

  it("法人連續買超、本益比、本站評等", () => {
    const chipsDays = [
      { date: "d1", foreignNet: -500 },
      { date: "d2", foreignNet: 2000 },
      { date: "d3", foreignNet: 3000 },
      { date: "d4", foreignNet: 1000 },
    ];
    const ctx = ctxOf(range(30, () => 100), { chipsDays, fundamentals: { peRatio: 12 }, ratingCode: "buy-on-pullback" });
    expect(evaluateIndicator("inst_streak", { who: "foreign", dir: "buy", days: 3 }, ctx).pass).toBe(true);
    expect(evaluateIndicator("inst_streak", { who: "foreign", dir: "buy", days: 4 }, ctx).pass).toBe(false);
    expect(evaluateIndicator("inst_sum", { who: "foreign", days: 3, op: "gt", lots: 5 }, ctx).pass).toBe(true);
    expect(evaluateIndicator("pe", { op: "lt", value: 15 }, ctx).pass).toBe(true);
    expect(evaluateIndicator("site_rating", { code: "buy" }, ctx).pass).toBe(true);
  });
});

const IND: UserIndicator[] = [
  { id: "i1", name: "RSI 超賣", typeId: "rsi", params: { period: 14, op: "lt", value: 30 } },
  { id: "i2", name: "跌破 20 日線", typeId: "price_vs_ma", params: { period: 20, op: "lt" } },
  { id: "i3", name: "RSI 過熱", typeId: "rsi", params: { period: 14, op: "gt", value: 70 } },
];
const ids = new Set(IND.map((i) => i.id));

describe("策略", () => {
  it("整理設定：不存在的指標 id 會被丟掉、數值夾範圍", () => {
    const cfg = normalizeStrategyConfig({ mode: "score", buy: { ids: ["i1", "zz"], match: 0 }, weights: { i1: 2, zz: 5, i2: 0 }, positionPct: 500 }, ids);
    expect(cfg.buy.ids).toEqual(["i1"]);
    expect(cfg.weights).toEqual({ i1: 2 });
    expect(cfg.positionPct).toBe(100);
    expect(cfg.mode).toBe("score");
  });

  it("條件式：全部符合 vs 至少 1 個", () => {
    const down = ctxOf(range(40, (i) => 100 - i));
    const all: StrategyConfig = normalizeStrategyConfig({ buy: { ids: ["i1", "i2", "i3"], match: 0 }, sell: { ids: ["i3"], match: 1 } }, ids);
    expect(evaluateStrategy(all, IND, down).buy).toBe(false);
    const any = normalizeStrategyConfig({ buy: { ids: ["i1", "i2", "i3"], match: 2 }, sell: { ids: ["i3"], match: 1 } }, ids);
    const d = evaluateStrategy(any, IND, down);
    expect(d.buy).toBe(true);
    expect(d.sell).toBe(false);
    expect(d.score).toBe(2);
    expect(d.summary).toContain("RSI 超賣");
  });

  it("加權計分：總分達門檻買、低於賣出門檻賣", () => {
    const cfg = normalizeStrategyConfig({ mode: "score", weights: { i1: 2, i2: 1, i3: -3 }, buyScore: 3, sellScore: -2 }, ids);
    expect(evaluateStrategy(cfg, IND, ctxOf(range(40, (i) => 100 - i)))).toMatchObject({ buy: true, sell: false, score: 3 });
    expect(evaluateStrategy(cfg, IND, ctxOf(range(40, (i) => 100 + i)))).toMatchObject({ buy: false, sell: true, score: -3 });
  });
});

describe("模擬倉", () => {
  const cfg: StrategyConfig = { ...normalizeStrategyConfig({}, ids), stopLossPct: 10, takeProfitPct: 20, positionPct: 30, maxPositions: 3 };
  const dec = (buy: boolean, sell = false, score = 1) => ({ buy, sell, score, hits: [], summary: buy ? "買進條件成立" : sell ? "賣出條件成立" : "" });
  const cand = (symbol: string, price: number, buy: boolean, sell = false, score = 1): Candidate => ({ symbol, market: "TW", name: symbol, price, decision: dec(buy, sell, score) });

  it("手動買賣：手續費、證交稅、現金不足與股數檢查", () => {
    let s: SimState = { initialCash: 100_000, cash: 100_000, positions: [] };
    const b = applyBuy(s, { symbol: "2330", market: "TW", name: "台積電", shares: 100, price: 500, day: "2026-10-01", reason: "手動", source: "manual" });
    expect(b.trade.fee).toBe(71); // 50000 × 0.1425%
    expect(b.state.cash).toBe(100_000 - 50_000 - 71);
    s = b.state;
    expect(() => applyBuy(s, { symbol: "2317", market: "TW", name: "x", shares: 1000, price: 200, day: "d", reason: "", source: "manual" })).toThrow("現金不足");
    const r = applySell(s, { symbol: "2330", market: "TW", shares: 100, price: 550, reason: "手動", source: "manual" });
    expect(r.trade.fee).toBe(78 + 165); // 手續費＋證交稅
    expect(r.trade.pnl).toBe(5000 - 243 - 71);
    expect(r.state.positions).toHaveLength(0);
    expect(() => applySell(r.state, { symbol: "2330", market: "TW", shares: 1, price: 1, reason: "", source: "manual" })).toThrow("沒有持有");
  });

  it("自動交易：停損、停利、策略賣出；依分數買進、受最多持有檔數限制；當天買的不當天賣", () => {
    const state = {
      initialCash: 1_000_000,
      cash: 500_000,
      positions: [
        { symbol: "A", market: "TW" as const, name: "A", shares: 1000, avgCost: 100, buyDay: "2026-09-01" },
        { symbol: "B", market: "TW" as const, name: "B", shares: 1000, avgCost: 100, buyDay: "2026-09-01" },
        { symbol: "C", market: "TW" as const, name: "C", shares: 1000, avgCost: 100, buyDay: "2026-10-08" },
      ],
    };
    const held = new Map([
      ["TW:A", cand("A", 89, false)], // 停損
      ["TW:B", cand("B", 105, false)], // 不動
      ["TW:C", cand("C", 50, false)], // 當天買的不賣
    ]);
    const { state: next, trades } = runSimDay(state, cfg, "2026-10-08", held, [cand("X", 100, true, false, 1), cand("Y", 50, true, false, 5), cand("B", 105, true)]);
    expect(trades.map((t) => `${t.side}:${t.symbol}`)).toEqual(["sell:A", "buy:Y"]); // 持有上限 3：賣掉 A 後 B、C 占 2 檔，只剩 1 個空位給分數最高的 Y
    expect(trades[0].reason).toContain("停損");
    expect(next.positions.map((p) => p.symbol).sort()).toEqual(["B", "C", "Y"].sort());
    expect(trades[1].shares).toBe(6000); // 初始資金 30% ＝ 300000 ÷ 50
  });

  it("模擬倉總值＝現金＋市值", () => {
    const s = { initialCash: 0, cash: 1000, positions: [{ symbol: "A", market: "TW" as const, name: "A", shares: 10, avgCost: 50, buyDay: "d" }] };
    expect(simEquity(s, new Map([["TW:A", 60]]))).toBe(1600);
    expect(simEquity(s, new Map())).toBe(1500);
  });
});
