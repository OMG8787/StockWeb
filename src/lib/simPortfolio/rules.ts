import type { SiteRating } from "@/lib/ai/siteRating";
import { tradeReward } from "@/lib/ai/learning/reward";
import { taipeiDayKey, taipeiWeekday } from "@/lib/pollingSchedule";
import { TW_BUY_COMMISSION_RATE, TW_SELL_COMMISSION_RATE, TW_SELL_TAX_RATE } from "@/lib/tradingCosts";
import type { SimHolding, SimNavPoint, SimSlotId, SimState, SimTrade } from "./types";

/**
 * AI 模擬投資組合：規則常數＋純邏輯（無 I/O，有測試 src/__tests__/simPortfolio.test.ts）。
 *
 * 2026-10-05 使用者：「新增一個像我的關注名單那樣，但變成是由AI來自動在盤中、盤後去改自己推薦的持股組合，
 * 總金額100萬，然後讓AI每天也自己去根據當時的狀況買賣，也自己學習，檢視自己的分析並改善。」
 *
 * 原則（CLAUDE.md「下限看模型、上限看我們」）：買賣全部由這裡的程式規則依「本站綜合評等」決定——
 * 買進候選＝今日建議名單（getActionBrief().picks，code＝建議買進），持有中的去留＝describeRatingForHolding
 * （續抱／加碼／減碼／出場，含停利）＋computeHoldingStop（持有中出場價）。不另寫任何評分。
 * AI 只在每天收盤後寫一段檢討（review.ts），不參與買賣。
 */

/** 初始資金（元）。 */
export const SIM_INITIAL_CAPITAL = 1_000_000;
/** 最多同時持有幾檔。 */
export const SIM_MAX_POSITIONS = 6;
/** 新買進一檔的目標金額占淨值比例。 */
export const SIM_NEW_POSITION_PCT = 0.15;
/** 單檔市值上限（占淨值；加碼最多加到這裡）。 */
export const SIM_MAX_POSITION_PCT = 0.2;
/** 單次加碼最多占淨值比例。 */
export const SIM_ADD_POSITION_PCT = 0.05;
/** 單筆交易金額低於這個就不做（避免零碎交易）。 */
export const SIM_MIN_TRADE_AMOUNT = 20_000;
/**
 * 股數單位：1 股（台股 1 張＝1000 股，整張以外的零頭用零股交易——盤中零股 09:00～13:30、盤後零股 13:40～14:30，
 * 成交價假設同整股）。不硬湊整張，否則高價股（例如一張上百萬）放不進單檔上限、資金配置會失真。
 */
export const SIM_SHARE_UNIT = 1;
/**
 * 漲跌幅達到這個百分比視為「可能鎖漲停／跌停、買不到／賣不掉」：漲幅 ≥ 它不買、跌幅 ≥ 它不賣（下一個時點再看）。
 * 台股漲跌幅限制 10%，留 0.5% 緩衝。
 */
export const SIM_LIMIT_LOCK_PCT = 9.5;
/** 交易紀錄最多保留幾筆（統計另外累計，不受影響）。 */
export const SIM_MAX_TRADES = 400;
/** AI 檢討最多保留幾篇（完整紀錄另存學習紀錄 learning:v1:sim-review:{日期}）。 */
export const SIM_MAX_REVIEWS = 20;
/** 冪等紀錄保留幾個時點。 */
const SIM_DONE_SLOTS_KEEP = 12;
/** 對照組：同期買進持有的 ETF。 */
export const SIM_BENCHMARK_ETF = "0050";

export interface SimSlotDef {
  id: SimSlotId;
  /** 台北時間當日第幾分鐘開始可以執行 */
  start: number;
  /** 最晚到第幾分鐘（含）還算這個時點；錯過就跳過 */
  end: number;
  label: string;
  /** 成交價規則（顯示用） */
  fill: string;
}

/**
 * 執行時點（台北時間、週一～五）。由 cron-job.org 每 5 分鐘打的 /api/cron/warm-cache 順帶觸發
 * （也可手動打 /api/cron/sim-portfolio）；同一天同一時點只執行一次（store.ts 冪等＋鎖）。
 * 成交價＝執行當下抓到的最新成交價（不用任何未來價格）：盤中兩個時點是即時價；13:35 是收盤價，
 * 對應真實的「盤後定價交易」（14:00～14:30 以收盤價成交）與盤後零股。
 */
export const SIM_SLOTS: readonly SimSlotDef[] = [
  { id: "0930", start: 9 * 60 + 30, end: 12 * 60 + 59, label: "盤中 09:30", fill: "執行當下即時成交價" },
  { id: "1300", start: 13 * 60, end: 13 * 60 + 29, label: "盤中 13:00", fill: "執行當下即時成交價" },
  { id: "1335", start: 13 * 60 + 35, end: 23 * 60 + 59, label: "收盤後 13:35", fill: "當日收盤價（盤後定價交易）" },
];

export function simSlotDef(id: SimSlotId): SimSlotDef {
  return SIM_SLOTS.find((s) => s.id === id)!;
}

function taipeiMinutes(now: Date): number {
  // 台北沒有日光節約時間，固定 UTC+8。
  return ((now.getUTCHours() + 8) % 24) * 60 + now.getUTCMinutes();
}

/** 現在落在哪個執行時點（週末、時點之間的空檔回 null）。 */
export function currentSimSlot(now: Date = new Date()): SimSlotDef | null {
  const wd = taipeiWeekday(now);
  if (wd === 0 || wd === 6) return null;
  const m = taipeiMinutes(now);
  return SIM_SLOTS.find((s) => m >= s.start && m <= s.end) ?? null;
}

export function slotDoneKey(day: string, slot: SimSlotId): string {
  return `${day}:${slot}`;
}

export function markSlotDone(state: SimState, day: string, slot: SimSlotId): void {
  const k = slotDoneKey(day, slot);
  state.doneSlots = [...state.doneSlots.filter((d) => d !== k), k].slice(-SIM_DONE_SLOTS_KEEP);
}

export function newSimState(now: Date, base: { etf: number | null; index: number | null }): SimState {
  return {
    version: 1,
    startDay: taipeiDayKey(now),
    startAt: now.toISOString(),
    initialCapital: SIM_INITIAL_CAPITAL,
    cash: SIM_INITIAL_CAPITAL,
    holdings: [],
    trades: [],
    nav: [],
    reviews: [],
    stats: { closedTrades: 0, wins: 0, realized: 0, fees: 0, buys: 0, sells: 0, rewardSum: 0, rewardCount: 0 },
    base,
    doneSlots: [],
  };
}

// ── 費用（跟 lib/portfolio.ts 同一套：逐項無條件捨去到元）──

export function buyFee(price: number, shares: number): number {
  return Math.floor(price * shares * TW_BUY_COMMISSION_RATE);
}

export function sellFee(price: number, shares: number): number {
  return Math.floor(price * shares * TW_SELL_COMMISSION_RATE) + Math.floor(price * shares * TW_SELL_TAX_RATE);
}

/** 預算內最多買幾股（含手續費，以 SIM_SHARE_UNIT 為單位）。 */
export function sharesForBudget(budget: number, price: number): number {
  if (!(price > 0) || !(budget > 0)) return 0;
  let s = Math.floor(budget / (price * (1 + TW_BUY_COMMISSION_RATE)) / SIM_SHARE_UNIT) * SIM_SHARE_UNIT;
  while (s > 0 && Math.round(price * s) + buyFee(price, s) > budget) s -= SIM_SHARE_UNIT;
  return s;
}

/** 減碼賣一半（無條件捨去；只剩 1 股就全賣）。 */
export function halfShares(shares: number): number {
  const half = Math.floor(shares / 2 / SIM_SHARE_UNIT) * SIM_SHARE_UNIT;
  return half > 0 ? half : shares;
}

// ── 決策 ──

/** 持有中一檔在這個時點的檢視結果（run.ts 依評等組好）。 */
export interface HeldReview {
  symbol: string;
  price: number;
  changePercent: number;
  /** 套過成本（停利）的評等：describeRatingForHolding(...).rating */
  rating: SiteRating;
  /** 這次 computeHoldingStop 算出的持有中出場價（存起來給下一個時點比對） */
  newStop: number | null;
}

export interface BuyCandidate {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  rating: SiteRating;
}

export interface SimOrder {
  symbol: string;
  name: string;
  side: "buy" | "sell";
  shares: number;
  price: number;
  ratingLabel: string;
  reason: string;
  /** 這筆賣出是減碼（標記 reduced） */
  reduce?: boolean;
  /** 這筆買進是加碼 */
  add?: boolean;
}

export function holdingsValue(holdings: SimHolding[], prices: Map<string, number>): number {
  return holdings.reduce((s, h) => s + h.shares * (prices.get(h.symbol) ?? h.avgCost), 0);
}

export function navOf(state: Pick<SimState, "cash" | "holdings">, prices: Map<string, number>): number {
  return Math.round(state.cash + holdingsValue(state.holdings, prices));
}

/** 當天賣掉過的代號（當天不再買回）。 */
function soldOn(state: SimState, day: string): Set<string> {
  return new Set(state.trades.filter((t) => t.day === day && t.side === "sell").map((t) => t.symbol));
}

/**
 * 依評等決定這個時點要下的單（純函式）。順序：先賣（停損→出場→減碼）釋出現金，再買新股（依今日建議名單順序），最後加碼。
 * - 觸及上一個時點記下的持有中出場價（現價 ≤ 出場價）→ 全部賣出（當天買的也賣）。
 * - 當天買進的不在當天因評等賣出（避免當沖來回）。
 * - 持有中「建議出場」→ 全賣；「建議減碼」→ 第一次賣一半，之後不重複減碼。
 * - 新買進：名單裡評等仍是建議買進、未持有、當天沒賣過、沒有接近漲停、持股未滿 SIM_MAX_POSITIONS，
 *   每檔目標 SIM_NEW_POSITION_PCT×淨值（現金不夠就用剩下的），低於 SIM_MIN_TRADE_AMOUNT 不買。
 * - 加碼：持有中「可分批加碼」、不是當天買的、當天沒加碼過，加到單檔上限 SIM_MAX_POSITION_PCT 為止，每次最多 SIM_ADD_POSITION_PCT。
 */
export function planSimOrders(input: {
  state: SimState;
  day: string;
  held: HeldReview[];
  candidates: BuyCandidate[];
  prices: Map<string, number>;
}): SimOrder[] {
  const { state, day, held, candidates, prices } = input;
  const orders: SimOrder[] = [];
  const nav = navOf(state, prices);
  let cash = state.cash;
  const byHolding = new Map(state.holdings.map((h) => [h.symbol, h]));
  const remaining = new Set(state.holdings.map((h) => h.symbol));

  for (const r of held) {
    const h = byHolding.get(r.symbol);
    if (!h || !(r.price > 0)) continue;
    if (r.changePercent <= -SIM_LIMIT_LOCK_PCT) continue; // 可能鎖跌停、賣不掉
    let sell: { shares: number; reason: string; reduce?: boolean } | null = null;
    if (h.stopPrice != null && r.price <= h.stopPrice) {
      sell = { shares: h.shares, reason: `現價 ${r.price} 跌破持有中出場價 ${h.stopPrice}，依紀律全部賣出` };
    } else if (h.buyDay !== day) {
      if (r.rating.holdingCode === "exit") sell = { shares: h.shares, reason: `評等轉為「${r.rating.holdingLabel}」：${r.rating.reason}` };
      else if (r.rating.holdingCode === "reduce" && !h.reduced)
        sell = { shares: halfShares(h.shares), reason: `評等轉為「${r.rating.holdingLabel}」，先賣一半：${r.rating.reason}`, reduce: true };
    }
    if (!sell) continue;
    orders.push({ symbol: h.symbol, name: h.name, side: "sell", shares: sell.shares, price: r.price, ratingLabel: r.rating.holdingLabel, reason: sell.reason, reduce: sell.reduce });
    cash += Math.round(r.price * sell.shares) - sellFee(r.price, sell.shares);
    if (sell.shares >= h.shares) remaining.delete(h.symbol);
  }

  const sold = soldOn(state, day);
  for (const o of orders) sold.add(o.symbol);
  for (const c of candidates) {
    if (remaining.size >= SIM_MAX_POSITIONS) break;
    if (c.rating.code !== "buy" || byHolding.has(c.symbol) || sold.has(c.symbol)) continue;
    if (!(c.price > 0) || c.changePercent >= SIM_LIMIT_LOCK_PCT) continue;
    const budget = Math.min(SIM_NEW_POSITION_PCT * nav, cash);
    if (budget < SIM_MIN_TRADE_AMOUNT) break;
    const shares = sharesForBudget(budget, c.price);
    if (shares <= 0 || Math.round(c.price * shares) < SIM_MIN_TRADE_AMOUNT) continue;
    orders.push({ symbol: c.symbol, name: c.name, side: "buy", shares, price: c.price, ratingLabel: c.rating.label, reason: c.rating.reason });
    cash -= Math.round(c.price * shares) + buyFee(c.price, shares);
    remaining.add(c.symbol);
  }

  for (const r of held) {
    const h = byHolding.get(r.symbol);
    if (!h || r.rating.holdingCode !== "add" || h.buyDay === day || h.lastAddDay === day) continue;
    if (orders.some((o) => o.symbol === h.symbol) || !(r.price > 0) || r.changePercent >= SIM_LIMIT_LOCK_PCT) continue;
    const room = SIM_MAX_POSITION_PCT * nav - h.shares * r.price;
    const budget = Math.min(room, SIM_ADD_POSITION_PCT * nav, cash);
    if (budget < SIM_MIN_TRADE_AMOUNT) continue;
    const shares = sharesForBudget(budget, r.price);
    if (shares <= 0 || Math.round(r.price * shares) < SIM_MIN_TRADE_AMOUNT) continue;
    orders.push({ symbol: h.symbol, name: h.name, side: "buy", shares, price: r.price, ratingLabel: r.rating.holdingLabel, reason: `持有中評等「${r.rating.holdingLabel}」，加碼（單檔上限 ${SIM_MAX_POSITION_PCT * 100}%）：${r.rating.reason}`, add: true });
    cash -= Math.round(r.price * shares) + buyFee(r.price, shares);
  }
  return orders;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 把一筆單套到狀態上（會修改 state），回傳成交紀錄。現金不夠的買單、超過持股的賣單直接拒絕（回 null）。
 * `index`：執行當下的加權指數（買進時記在持股上，賣出時算同期大盤報酬與獎勵）。
 */
export function applySimOrder(
  state: SimState,
  order: SimOrder,
  ctx: { at: string; day: string; slot: SimSlotId; index: number | null }
): SimTrade | null {
  const { price, shares } = order;
  if (!(price > 0) || !(shares > 0)) return null;
  const amount = Math.round(price * shares);
  const base = { at: ctx.at, day: ctx.day, slot: ctx.slot, symbol: order.symbol, name: order.name, shares, price, amount, ratingLabel: order.ratingLabel, reason: order.reason };
  if (order.side === "buy") {
    const fee = buyFee(price, shares);
    if (amount + fee > state.cash) return null;
    state.cash -= amount + fee;
    const h = state.holdings.find((x) => x.symbol === order.symbol);
    if (h) {
      h.avgCost = r2((h.avgCost * h.shares + price * shares) / (h.shares + shares));
      h.shares += shares;
      h.invested += amount + fee;
      if (order.add) h.lastAddDay = ctx.day;
    } else {
      state.holdings.push({ symbol: order.symbol, name: order.name, shares, avgCost: price, invested: amount + fee, buyDay: ctx.day, buyAt: ctx.at, buyIndex: ctx.index, stopPrice: null });
    }
    state.stats.buys++;
    state.stats.fees += fee;
    const t: SimTrade = { ...base, side: "buy", fee };
    pushTrade(state, t);
    return t;
  }
  const h = state.holdings.find((x) => x.symbol === order.symbol);
  if (!h || shares > h.shares) return null;
  const fee = sellFee(price, shares);
  const costPortion = (h.invested * shares) / h.shares;
  const realized = Math.round(amount - fee - costPortion);
  const realizedPct = costPortion > 0 ? r2((realized / costPortion) * 100) : 0;
  const indexPct = h.buyIndex != null && ctx.index != null && h.buyIndex > 0 ? r2((ctx.index / h.buyIndex - 1) * 100) : null;
  const reward = tradeReward(realizedPct, indexPct);
  state.cash += amount - fee;
  h.invested = Math.round(h.invested - costPortion);
  h.shares -= shares;
  if (order.reduce) h.reduced = true;
  if (h.shares <= 0) state.holdings = state.holdings.filter((x) => x !== h);
  const s = state.stats;
  s.sells++;
  s.fees += fee;
  s.closedTrades++;
  if (realized > 0) s.wins++;
  s.realized += realized;
  if (reward != null) {
    s.rewardSum = r2(s.rewardSum + reward);
    s.rewardCount++;
  }
  const t: SimTrade = { ...base, side: "sell", fee, realized, realizedPct, indexPct, reward };
  pushTrade(state, t);
  return t;
}

function pushTrade(state: SimState, t: SimTrade): void {
  state.trades = [t, ...state.trades].slice(0, SIM_MAX_TRADES);
}

/** 記今天的淨值點（同一天覆寫）。 */
export function upsertNavPoint(state: SimState, p: SimNavPoint): void {
  const i = state.nav.findIndex((x) => x.day === p.day);
  if (i >= 0) state.nav[i] = p;
  else state.nav = [...state.nav, p].sort((a, b) => a.day.localeCompare(b.day));
}

// ── 成效 ──

/** 最大回撤（%，正數）：淨值序列中從前高到之後最低的最大跌幅。 */
export function maxDrawdownPct(navs: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of navs) {
    if (!(v > 0)) continue;
    peak = Math.max(peak, v);
    mdd = Math.max(mdd, (1 - v / peak) * 100);
  }
  return r2(mdd);
}

export function pctChange(now: number | null | undefined, base: number | null | undefined): number | null {
  if (now == null || base == null || !(base > 0) || !Number.isFinite(now)) return null;
  return r2((now / base - 1) * 100);
}

export interface SimPerformance {
  nav: number;
  totalReturnPct: number;
  /** 今日報酬：相對前一個交易日的淨值點（沒有就相對初始資金） */
  dayReturnPct: number;
  /** 同期 0050 買進持有報酬（只算價格，未計股利與費用） */
  etfReturnPct: number | null;
  /** 同期加權指數報酬 */
  indexReturnPct: number | null;
  /** 超越 0050 幾個百分點 */
  vsEtfPct: number | null;
  maxDrawdownPct: number;
  unrealized: number;
  realized: number;
  /** 已平倉勝率（%）；沒有平倉是 null */
  winRatePct: number | null;
  tradeCount: number;
  avgRewardPct: number | null;
}

/**
 * 成效（純函式）：`live` 是現在的報價（持股、0050、加權指數），`today` 台北日期。
 * 淨值以持股現價計、未扣假設賣出成本（同券商 App「市值」）；未實現損益則扣掉賣出成本（同關注清單算法）。
 */
export function computePerformance(
  state: SimState,
  live: { prices: Map<string, number>; etf: number | null; index: number | null },
  today: string
): SimPerformance {
  const nav = navOf(state, live.prices);
  const prev = [...state.nav].reverse().find((p) => p.day < today);
  const unrealized = state.holdings.reduce((s, h) => {
    const p = live.prices.get(h.symbol) ?? h.avgCost;
    return s + Math.round(p * h.shares) - sellFee(p, h.shares) - h.invested;
  }, 0);
  const etfReturnPct = pctChange(live.etf, state.base.etf);
  const totalReturnPct = r2((nav / state.initialCapital - 1) * 100);
  const series = [...state.nav.filter((p) => p.day < today).map((p) => p.nav), nav];
  return {
    nav,
    totalReturnPct,
    dayReturnPct: r2((nav / (prev?.nav ?? state.initialCapital) - 1) * 100),
    etfReturnPct,
    indexReturnPct: pctChange(live.index, state.base.index),
    vsEtfPct: etfReturnPct == null ? null : r2(totalReturnPct - etfReturnPct),
    maxDrawdownPct: maxDrawdownPct([state.initialCapital, ...series]),
    unrealized: Math.round(unrealized),
    realized: state.stats.realized,
    winRatePct: state.stats.closedTrades > 0 ? r2((state.stats.wins / state.stats.closedTrades) * 100) : null,
    tradeCount: state.stats.buys + state.stats.sells,
    avgRewardPct: state.stats.rewardCount > 0 ? r2(state.stats.rewardSum / state.stats.rewardCount) : null,
  };
}
