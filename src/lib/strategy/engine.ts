import { buyFee as twBuyFee, sellFee as twSellFee } from "@/lib/simPortfolio/rules";
import { evaluateIndicator, type EvalContext, type EvalResult } from "./indicatorCatalog";

/**
 * 策略判斷與模擬倉每日交易的純邏輯（不抓資料、不寫試算表；I/O 在 runner.ts）。
 *
 * 策略有兩種模式（2026-10-08 使用者要求兩種都要、每個策略自選）：
 *  - rules（條件式）：買進條件、賣出條件各一組參考指標，各自「全部符合」或「至少 N 個符合」。
 *  - score（加權計分）：每個參考指標一個權重（可為負），成立就加上權重；總分 ≥ 買進門檻買、≤ 賣出門檻賣。
 * 兩種模式共用風控：停損 %、停利 %、最長持有天數、每檔投入資金比例、最多同時持有幾檔。
 */

export interface UserIndicator {
  id: string;
  name: string;
  typeId: string;
  params: Record<string, number | string>;
}

export interface ConditionSet {
  ids: string[];
  /** 0＝全部符合；N＝至少 N 個符合 */
  match: number;
}

export interface StrategyConfig {
  mode: "rules" | "score";
  buy: ConditionSet;
  sell: ConditionSet;
  /** score 模式：參考指標 id → 權重 */
  weights: Record<string, number>;
  buyScore: number;
  sellScore: number;
  /** 0＝不使用 */
  stopLossPct: number;
  takeProfitPct: number;
  maxHoldDays: number;
  /** 每檔投入「初始資金」的百分比 */
  positionPct: number;
  maxPositions: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  mode: "rules",
  buy: { ids: [], match: 0 },
  sell: { ids: [], match: 1 },
  weights: {},
  buyScore: 3,
  sellScore: -1,
  stopLossPct: 8,
  takeProfitPct: 20,
  maxHoldDays: 0,
  positionPct: 20,
  maxPositions: 5,
};

const clampNum = (v: unknown, min: number, max: number, d: number) => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : d;
};

/** 整理使用者送來的策略設定：只保留存在的參考指標 id，數值夾在合理範圍。 */
export function normalizeStrategyConfig(raw: unknown, validIds: Set<string>): StrategyConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_STRATEGY_CONFIG;
  const set = (v: unknown, dm: number): ConditionSet => {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const ids = Array.isArray(o.ids) ? [...new Set(o.ids.filter((x): x is string => typeof x === "string" && validIds.has(x)))] : [];
    return { ids, match: Math.round(clampNum(o.match, 0, 50, dm)) };
  };
  const weights: Record<string, number> = {};
  if (r.weights && typeof r.weights === "object") {
    for (const [k, v] of Object.entries(r.weights as Record<string, unknown>)) {
      if (validIds.has(k)) {
        const w = clampNum(v, -100, 100, 0);
        if (w !== 0) weights[k] = w;
      }
    }
  }
  return {
    mode: r.mode === "score" ? "score" : "rules",
    buy: set(r.buy, d.buy.match),
    sell: set(r.sell, d.sell.match),
    weights,
    buyScore: clampNum(r.buyScore, -1000, 1000, d.buyScore),
    sellScore: clampNum(r.sellScore, -1000, 1000, d.sellScore),
    stopLossPct: clampNum(r.stopLossPct, 0, 100, d.stopLossPct),
    takeProfitPct: clampNum(r.takeProfitPct, 0, 1000, d.takeProfitPct),
    maxHoldDays: Math.round(clampNum(r.maxHoldDays, 0, 3650, d.maxHoldDays)),
    positionPct: clampNum(r.positionPct, 1, 100, d.positionPct),
    maxPositions: Math.round(clampNum(r.maxPositions, 1, 50, d.maxPositions)),
  };
}

export interface IndicatorHit extends EvalResult {
  id: string;
  name: string;
}

export interface StrategyDecision {
  buy: boolean;
  sell: boolean;
  /** 排序用：score 模式＝總分；rules 模式＝買進條件成立個數 */
  score: number;
  hits: IndicatorHit[];
  /** 一句話摘要（交易紀錄的「原因」） */
  summary: string;
}

function setPasses(set: ConditionSet, results: Map<string, IndicatorHit>): { pass: boolean; count: number } {
  if (set.ids.length === 0) return { pass: false, count: 0 };
  const count = set.ids.filter((id) => results.get(id)?.pass === true).length;
  const need = set.match <= 0 ? set.ids.length : Math.min(set.match, set.ids.length);
  return { pass: count >= need, count };
}

/** 用策略判斷一檔股票（ctx 由 runner 準備好）。 */
export function evaluateStrategy(cfg: StrategyConfig, indicators: UserIndicator[], ctx: EvalContext): StrategyDecision {
  const byId = new Map(indicators.map((i) => [i.id, i]));
  const used = cfg.mode === "score" ? Object.keys(cfg.weights) : [...new Set([...cfg.buy.ids, ...cfg.sell.ids])];
  const results = new Map<string, IndicatorHit>();
  for (const id of used) {
    const ind = byId.get(id);
    if (!ind) continue;
    results.set(id, { id, name: ind.name, ...evaluateIndicator(ind.typeId, ind.params, ctx) });
  }
  const hits = [...results.values()];
  const passedNames = hits.filter((h) => h.pass).map((h) => h.name);

  if (cfg.mode === "score") {
    const score = hits.reduce((a, h) => a + (h.pass ? cfg.weights[h.id] ?? 0 : 0), 0);
    return {
      buy: hits.length > 0 && score >= cfg.buyScore,
      sell: hits.length > 0 && score <= cfg.sellScore,
      score,
      hits,
      summary: `總分 ${Math.round(score * 100) / 100}${passedNames.length ? `（${passedNames.join("、")}）` : ""}`,
    };
  }
  const b = setPasses(cfg.buy, results);
  const s = setPasses(cfg.sell, results);
  const names = (set: ConditionSet) => set.ids.filter((id) => results.get(id)?.pass).map((id) => results.get(id)!.name);
  return {
    buy: b.pass,
    sell: s.pass,
    score: b.count,
    hits,
    summary: b.pass ? `買進條件成立：${names(cfg.buy).join("、")}` : s.pass ? `賣出條件成立：${names(cfg.sell).join("、")}` : "條件未成立",
  };
}

// ============================================================
// 模擬倉
// ============================================================

export interface SimPosition {
  symbol: string;
  market: "TW" | "US";
  name: string;
  shares: number;
  /** 平均成本（每股，不含手續費） */
  avgCost: number;
  /** 第一次買進的台北日期 */
  buyDay: string;
}

export interface SimState {
  initialCash: number;
  cash: number;
  positions: SimPosition[];
}

export interface SimTradeInput {
  side: "buy" | "sell";
  symbol: string;
  market: "TW" | "US";
  name: string;
  shares: number;
  price: number;
  fee: number;
  /** 賣出才有：已實現損益（扣成本與買賣手續費之後的近似值） */
  pnl?: number;
  reason: string;
  source: "auto" | "manual";
}

/** 台股依網站既有的手續費／證交稅規則；美股以零手續費模擬。 */
export function tradeFee(side: "buy" | "sell", market: "TW" | "US", price: number, shares: number): number {
  if (market !== "TW") return 0;
  return side === "buy" ? twBuyFee(price, shares) : twSellFee(price, shares);
}

function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

export class SimTradeError extends Error {}

/** 下一筆買單（手動或自動共用）：回傳新狀態與成交紀錄；現金不足、股數不合法就丟錯。 */
export function applyBuy(
  state: SimState,
  o: { symbol: string; market: "TW" | "US"; name: string; shares: number; price: number; day: string; reason: string; source: "auto" | "manual" },
): { state: SimState; trade: SimTradeInput } {
  const shares = Math.floor(o.shares);
  if (!(shares >= 1)) throw new SimTradeError("股數至少 1 股");
  if (!(o.price > 0)) throw new SimTradeError("價格不正確");
  const fee = tradeFee("buy", o.market, o.price, shares);
  const cost = o.price * shares + fee;
  if (cost > state.cash + 1e-6) throw new SimTradeError(`現金不足（需要 ${Math.ceil(cost).toLocaleString()}，剩 ${Math.floor(state.cash).toLocaleString()}）`);
  const positions = state.positions.map((p) => ({ ...p }));
  const held = positions.find((p) => p.symbol === o.symbol && p.market === o.market);
  if (held) {
    held.avgCost = (held.avgCost * held.shares + o.price * shares) / (held.shares + shares);
    held.shares += shares;
  } else {
    positions.push({ symbol: o.symbol, market: o.market, name: o.name, shares, avgCost: o.price, buyDay: o.day });
  }
  return {
    state: { ...state, cash: state.cash - cost, positions },
    trade: { side: "buy", symbol: o.symbol, market: o.market, name: o.name, shares, price: o.price, fee, reason: o.reason, source: o.source },
  };
}

export function applySell(
  state: SimState,
  o: { symbol: string; market: "TW" | "US"; shares: number; price: number; reason: string; source: "auto" | "manual" },
): { state: SimState; trade: SimTradeInput } {
  const positions = state.positions.map((p) => ({ ...p }));
  const held = positions.find((p) => p.symbol === o.symbol && p.market === o.market);
  if (!held) throw new SimTradeError("模擬倉沒有持有這檔股票");
  const shares = Math.floor(o.shares);
  if (!(shares >= 1) || shares > held.shares) throw new SimTradeError(`賣出股數要在 1～${held.shares} 之間`);
  if (!(o.price > 0)) throw new SimTradeError("價格不正確");
  const fee = tradeFee("sell", o.market, o.price, shares);
  const buyFeePart = tradeFee("buy", o.market, held.avgCost, shares);
  const pnl = Math.round((o.price - held.avgCost) * shares - fee - buyFeePart);
  held.shares -= shares;
  return {
    state: { ...state, cash: state.cash + o.price * shares - fee, positions: positions.filter((p) => p.shares > 0) },
    trade: { side: "sell", symbol: o.symbol, market: o.market, name: held.name, shares, price: o.price, fee, pnl, reason: o.reason, source: o.source },
  };
}

export interface Candidate {
  symbol: string;
  market: "TW" | "US";
  name: string;
  /** 當天收盤價 */
  price: number;
  decision: StrategyDecision;
}

/**
 * 一個交易日的自動交易：先處理持股（停損→停利→最長持有→策略賣出訊號），再依分數高低買進新標的。
 * 當天買的不當天賣；同一檔已持有就不再自動加碼。prices 必須包含所有持股的當天價格（沒有價格的持股略過）。
 */
export function runSimDay(
  state: SimState,
  cfg: StrategyConfig,
  day: string,
  held: Map<string, Candidate>,
  candidates: Candidate[],
): { state: SimState; trades: SimTradeInput[] } {
  let s = state;
  const trades: SimTradeInput[] = [];

  for (const p of state.positions) {
    const c = held.get(`${p.market}:${p.symbol}`);
    if (!c || p.buyDay === day) continue;
    const chg = (c.price / p.avgCost - 1) * 100;
    let reason = "";
    if (cfg.stopLossPct > 0 && chg <= -cfg.stopLossPct) reason = `停損（${chg.toFixed(1)}%）`;
    else if (cfg.takeProfitPct > 0 && chg >= cfg.takeProfitPct) reason = `停利（+${chg.toFixed(1)}%）`;
    else if (cfg.maxHoldDays > 0 && dayDiff(p.buyDay, day) >= cfg.maxHoldDays) reason = `持有滿 ${cfg.maxHoldDays} 天`;
    else if (c.decision.sell) reason = c.decision.summary;
    if (!reason) continue;
    const r = applySell(s, { symbol: p.symbol, market: p.market, shares: p.shares, price: c.price, reason, source: "auto" });
    s = r.state;
    trades.push(r.trade);
  }

  const heldKeys = new Set(s.positions.map((p) => `${p.market}:${p.symbol}`));
  const soldToday = new Set(trades.map((t) => `${t.market}:${t.symbol}`));
  const picks = candidates
    .filter((c) => c.decision.buy && c.price > 0 && !heldKeys.has(`${c.market}:${c.symbol}`) && !soldToday.has(`${c.market}:${c.symbol}`))
    .sort((a, b) => b.decision.score - a.decision.score || a.symbol.localeCompare(b.symbol));
  const budget = (state.initialCash * cfg.positionPct) / 100;
  for (const c of picks) {
    if (s.positions.length >= cfg.maxPositions) break;
    const spend = Math.min(budget, s.cash);
    let shares = Math.floor(spend / c.price);
    while (shares > 0 && c.price * shares + tradeFee("buy", c.market, c.price, shares) > s.cash) shares--;
    if (shares < 1) continue;
    const r = applyBuy(s, { symbol: c.symbol, market: c.market, name: c.name, shares, price: c.price, day, reason: c.decision.summary, source: "auto" });
    s = r.state;
    trades.push(r.trade);
  }
  return { state: s, trades };
}

/** 模擬倉總值＝現金＋持股市值（沒有現價的持股用成本價）。 */
export function simEquity(state: SimState, prices: Map<string, number>): number {
  return state.cash + state.positions.reduce((a, p) => a + p.shares * (prices.get(`${p.market}:${p.symbol}`) ?? p.avgCost), 0);
}
