import type { SiteRating } from "@/lib/ai/siteRating";
import { tradeReward } from "@/lib/ai/learning/reward";
import { taipeiDayKey, taipeiWeekday } from "@/lib/pollingSchedule";
import { TW_BUY_COMMISSION_RATE, TW_SELL_COMMISSION_RATE, TW_SELL_TAX_RATE } from "@/lib/tradingCosts";
import type { SimHolding, SimNavPoint, SimPendingOrder, SimSlotId, SimState, SimTrade } from "./types";

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
 * 保守備援：讀不到 MIS 五檔／漲跌停價時，漲幅 ≥ 它視為漲停買不到、跌幅 ≥ 它視為跌停賣不掉（台股漲跌幅限制 10%，留 0.5% 緩衝）。
 * 讀得到五檔時改用 decideFill 的精確規則（現價＝漲停且賣方無掛單才算鎖死）。
 */
export const SIM_LIMIT_LOCK_PCT = 9.5;
/** 單筆委託最多成交該股當日（到執行當下）累積成交量的這個比例，超過就部分成交（大單吃不下）。 */
export const SIM_MAX_VOLUME_SHARE = 0.05;
/** 台股 1 張股數（盤後定價只收整張，零頭走盤後零股）。 */
export const SIM_BOARD_LOT = 1000;
/** 盤後定價交易的撮合時間（台北）；13:35 那輪下的單記成這個時間成交。 */
export const SIM_FIXED_FILL_TIME = "14:30";
/** 交易紀錄最多保留幾筆（統計另外累計，不受影響）。 */
export const SIM_MAX_TRADES = 400;
/** AI 檢討最多保留幾篇（完整紀錄另存學習紀錄 learning:v1:sim-review:{日期}）。 */
export const SIM_MAX_REVIEWS = 20;
/** 冪等紀錄保留幾個時點。 */
const SIM_DONE_SLOTS_KEEP = 12;
/** 對照組：同期買進持有的 ETF。 */
export const SIM_BENCHMARK_ETF = "0050";

export type SimSlotKind = "continuous" | "fixed-decide" | "fixed-settle";

export interface SimSlotDef {
  id: SimSlotId;
  /** 台北時間當日第幾分鐘開始可以執行 */
  start: number;
  /** 最晚到第幾分鐘（含）還算這個時點；錯過就跳過 */
  end: number;
  /** continuous＝盤中立即撮合；fixed-decide＝盤後定價下單（委託中）；fixed-settle＝14:30 後以收盤價結算委託 */
  kind: SimSlotKind;
  label: string;
  /** 成交價規則（顯示用） */
  fill: string;
}

/**
 * 執行時點（台北時間、週一～五）。由 cron-job.org 每 5 分鐘打的 /api/cron/warm-cache 順帶觸發
 * （也可手動打 /api/cron/sim-portfolio）；同一天同一時點只執行一次（store.ts 冪等＋鎖）。不用任何未來價格：
 * - 盤中 09:30、13:00：執行當下立即撮合，買進用最佳賣價、賣出用最佳買價（讀不到五檔才用最近成交價）。
 * - 13:35～14:29 下單：台股「盤後定價交易」（14:00～14:30 收單、14:30 以當日收盤價撮合，只收整張）＋零頭走「盤後零股」
 *   （13:40～14:30 集合競價、14:30 撮合）。先記成委託中，14:35 起那一輪才以收盤價結算、成交時間記 14:30。
 *   盤後零股的實際撮合價不一定等於收盤價，這裡拿不到盤後零股成交價，以收盤價近似並在成交依據註明。
 * 2026-10-06 使用者：「13:30~14:30也可以盤後交易，以14:30的成交價為主」。
 */
export const SIM_SLOTS: readonly SimSlotDef[] = [
  { id: "0930", start: 9 * 60 + 30, end: 12 * 60 + 59, kind: "continuous", label: "盤中 09:30", fill: "立即撮合：買用最佳賣價、賣用最佳買價" },
  { id: "1300", start: 13 * 60, end: 13 * 60 + 29, kind: "continuous", label: "盤中 13:00", fill: "立即撮合：買用最佳賣價、賣用最佳買價" },
  { id: "1335", start: 13 * 60 + 35, end: 14 * 60 + 29, kind: "fixed-decide", label: "盤後 13:35 下單", fill: "盤後定價／盤後零股委託，14:30 成交" },
  { id: "1435", start: 14 * 60 + 35, end: 23 * 60 + 59, kind: "fixed-settle", label: "14:35 盤後成交結算", fill: "當日收盤價（零股以收盤價近似）" },
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
    archiveBackfilled: true,
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
  return new Set(state.trades.filter((t) => t.day === day && t.side === "sell" && t.status !== "rejected").map((t) => t.symbol));
}

/**
 * 依評等決定這個時點要下的單（純函式；能不能成交、成交價由 decideFill 另外判斷）。順序：先賣（停損→出場→減碼）釋出現金，再買新股（依今日建議名單順序），最後加碼。
 * - 觸及上一個時點記下的持有中出場價（現價 ≤ 出場價）→ 全部賣出（當天買的也賣）。
 * - 當天買進的不在當天因評等賣出（避免當沖來回）。
 * - 持有中「建議出場」→ 全賣；「建議減碼」→ 第一次賣一半，之後不重複減碼。
 * - 新買進：名單裡評等仍是建議買進、未持有、當天沒賣過、持股未滿 SIM_MAX_POSITIONS，
 *   每檔目標 SIM_NEW_POSITION_PCT×淨值（現金不夠就用剩下的），低於 SIM_MIN_TRADE_AMOUNT 不買。
 * - 加碼：持有中「可分批加碼」、不是當天買的、當天沒加碼過，加到單檔上限 SIM_MAX_POSITION_PCT 為止，每次最多 SIM_ADD_POSITION_PCT。
 */
/** 決策說明：key＝`c:{代號}`（候選）或 `h:{代號}`（持股），value＝動作或不動作的原因（封存「決策紀錄」用）。 */
export type SimPlanExplain = Map<string, string>;

export function planSimOrders(input: {
  state: SimState;
  day: string;
  held: HeldReview[];
  candidates: BuyCandidate[];
  prices: Map<string, number>;
  /** 有給就逐檔寫下選或不選、動或不動的原因（不影響決策） */
  explain?: SimPlanExplain;
}): SimOrder[] {
  const { state, day, held, candidates, prices } = input;
  const why = (k: string, v: string) => input.explain?.set(k, v);
  const orders: SimOrder[] = [];
  const nav = navOf(state, prices);
  let cash = state.cash;
  const byHolding = new Map(state.holdings.map((h) => [h.symbol, h]));
  const remaining = new Set(state.holdings.map((h) => h.symbol));

  for (const r of held) {
    const h = byHolding.get(r.symbol);
    if (!h) continue;
    if (!(r.price > 0)) {
      why(`h:${r.symbol}`, "讀不到價格，這個時點不動作");
      continue;
    }
    let sell: { shares: number; reason: string; reduce?: boolean } | null = null;
    if (h.stopPrice != null && r.price <= h.stopPrice) {
      sell = { shares: h.shares, reason: `現價 ${r.price} 跌破持有中出場價 ${h.stopPrice}，依紀律全部賣出` };
    } else if (h.buyDay === day) {
      why(`h:${r.symbol}`, `今天剛買進，不因評等當天賣（評等「${r.rating.holdingLabel}」）`);
    } else if (r.rating.holdingCode === "exit") {
      sell = { shares: h.shares, reason: `評等轉為「${r.rating.holdingLabel}」：${r.rating.reason}` };
    } else if (r.rating.holdingCode === "reduce") {
      if (!h.reduced) sell = { shares: halfShares(h.shares), reason: `評等轉為「${r.rating.holdingLabel}」，先賣一半：${r.rating.reason}`, reduce: true };
      else why(`h:${r.symbol}`, `評等「${r.rating.holdingLabel}」，但已減碼過一次，不重複減碼（等出場或停損）`);
    } else if (r.rating.holdingCode === "hold") {
      why(`h:${r.symbol}`, `評等「${r.rating.holdingLabel}」，續抱不動作`);
    }
    if (!sell) continue;
    orders.push({ symbol: h.symbol, name: h.name, side: "sell", shares: sell.shares, price: r.price, ratingLabel: r.rating.holdingLabel, reason: sell.reason, reduce: sell.reduce });
    why(`h:${r.symbol}`, `${sell.reduce ? "減碼賣一半" : "全部賣出"}：${sell.reason}`);
    cash += Math.round(r.price * sell.shares) - sellFee(r.price, sell.shares);
    if (sell.shares >= h.shares) remaining.delete(h.symbol);
  }

  const sold = soldOn(state, day);
  for (const o of orders) sold.add(o.symbol);
  for (const c of candidates) {
    const k = `c:${c.symbol}`;
    if (c.rating.code !== "buy") {
      why(k, `評等不是建議買進（${c.rating.label}）`);
      continue;
    }
    if (byHolding.has(c.symbol)) {
      why(k, "已持有（改看持股的加碼條件）");
      continue;
    }
    if (sold.has(c.symbol)) {
      why(k, "今天剛賣出，當天不買回");
      continue;
    }
    if (remaining.size >= SIM_MAX_POSITIONS) {
      why(k, `持股已滿 ${SIM_MAX_POSITIONS} 檔`);
      continue;
    }
    if (!(c.price > 0)) {
      why(k, "讀不到價格");
      continue;
    }
    const budget = Math.min(SIM_NEW_POSITION_PCT * nav, cash);
    if (budget < SIM_MIN_TRADE_AMOUNT) {
      why(k, `可用現金 ${Math.round(cash)} 元，不足單筆下限 ${SIM_MIN_TRADE_AMOUNT} 元`);
      continue;
    }
    const shares = sharesForBudget(budget, c.price);
    if (shares <= 0 || Math.round(c.price * shares) < SIM_MIN_TRADE_AMOUNT) {
      why(k, `預算 ${Math.round(budget)} 元買不到足額（低於單筆下限 ${SIM_MIN_TRADE_AMOUNT} 元）`);
      continue;
    }
    orders.push({ symbol: c.symbol, name: c.name, side: "buy", shares, price: c.price, ratingLabel: c.rating.label, reason: c.rating.reason });
    why(k, `買進 ${shares} 股（約淨值 ${SIM_NEW_POSITION_PCT * 100}%）：${c.rating.label}`);
    cash -= Math.round(c.price * shares) + buyFee(c.price, shares);
    remaining.add(c.symbol);
  }

  for (const r of held) {
    const h = byHolding.get(r.symbol);
    if (!h || r.rating.holdingCode !== "add") continue;
    const k = `h:${r.symbol}`;
    if (orders.some((o) => o.symbol === h.symbol) || !(r.price > 0)) continue;
    if (h.buyDay === day || h.lastAddDay === day) {
      why(k, `評等「${r.rating.holdingLabel}」，但${h.buyDay === day ? "今天剛買進" : "今天已加碼過"}，不再加碼`);
      continue;
    }
    const room = SIM_MAX_POSITION_PCT * nav - h.shares * r.price;
    const budget = Math.min(room, SIM_ADD_POSITION_PCT * nav, cash);
    if (budget < SIM_MIN_TRADE_AMOUNT) {
      why(k, `評等「${r.rating.holdingLabel}」，但${room < SIM_MIN_TRADE_AMOUNT ? `已接近單檔上限 ${SIM_MAX_POSITION_PCT * 100}%` : "現金不足"}，不加碼`);
      continue;
    }
    const shares = sharesForBudget(budget, r.price);
    if (shares <= 0 || Math.round(r.price * shares) < SIM_MIN_TRADE_AMOUNT) {
      why(k, `評等「${r.rating.holdingLabel}」，但可加碼金額低於單筆下限，不加碼`);
      continue;
    }
    orders.push({ symbol: h.symbol, name: h.name, side: "buy", shares, price: r.price, ratingLabel: r.rating.holdingLabel, reason: `持有中評等「${r.rating.holdingLabel}」，加碼（單檔上限 ${SIM_MAX_POSITION_PCT * 100}%）：${r.rating.reason}`, add: true });
    why(k, `加碼 ${shares} 股：評等「${r.rating.holdingLabel}」`);
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
  ctx: { at: string; day: string; slot: SimSlotId; index: number | null },
  basis?: string
): SimTrade | null {
  const { price, shares } = order;
  if (!(price > 0) || !(shares > 0)) return null;
  const amount = Math.round(price * shares);
  const base = {
    at: ctx.at,
    day: ctx.day,
    slot: ctx.slot,
    symbol: order.symbol,
    name: order.name,
    shares,
    price,
    amount,
    ratingLabel: order.ratingLabel,
    reason: order.reason,
    status: "filled" as const,
    ...(basis ? { basis } : {}),
  };
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

// ── 成交判斷（漲跌停鎖死、五檔、成交量上限）──

/** 盤口（MIS u／w／a／b／f／g／v／z），由 depth.ts 讀；讀不到是 null。量的單位都是股。 */
export interface SimDepth {
  last: number | null;
  prevClose: number;
  limitUp: number | null;
  limitDown: number | null;
  bestAsk: number | null;
  bestAskVol: number;
  bestBid: number | null;
  bestBidVol: number;
  volumeShares: number;
  /** MIS 資料所屬交易日（YYYY-MM-DD） */
  tradeDate: string | null;
}

export type FillDecision =
  | { status: "filled"; price: number; shares: number; basis: string }
  | { status: "rejected"; reason: string };

const fmtShares = (n: number) => n.toLocaleString("en-US");

/**
 * 一筆單能不能成交、成交價與股數（純函式）。2026-10-06 使用者：「有些漲停可能買不到或跌停可能賣不掉的也要注意，要讓模擬越真實越好。」
 * - mode "continuous"（盤中立即撮合）：現價＝漲停且賣方無掛單（漲停鎖死）→ 買不到；現價＝跌停且買方無掛單（跌停鎖死）→ 賣不掉。
 *   買進價＝最佳賣價、賣出價＝最佳買價；沒有那一側五檔才用最近成交價。
 * - mode "fixed"（盤後定價 14:30）：成交價＝當日收盤價；收盤＝漲停視為買不到、收盤＝跌停視為賣不掉（鎖死時盤後也排不到）；
 *   整張以外的零頭走盤後零股，以收盤價近似。
 * - 讀不到盤口（depth＝null）：退回保守規則（漲幅 ≥ SIM_LIMIT_LOCK_PCT 不買、跌幅 ≥ 它不賣），價格用報價的成交價，並寫明原因。
 * - 成交量上限：單筆最多成交當日累積成交量的 SIM_MAX_VOLUME_SHARE，超過就部分成交；一股都分不到就未成交。
 */
export function decideFill(
  order: Pick<SimOrder, "side" | "shares">,
  depth: SimDepth | null,
  mode: "continuous" | "fixed",
  fallback: { price: number; changePercent: number }
): FillDecision {
  const buy = order.side === "buy";
  let price: number;
  let basis: string;
  if (!depth) {
    if (buy && fallback.changePercent >= SIM_LIMIT_LOCK_PCT)
      return { status: "rejected", reason: `未成交：讀不到五檔與漲停價，漲幅 ${fallback.changePercent}% ≥ ${SIM_LIMIT_LOCK_PCT}% 保守視為漲停買不到` };
    if (!buy && fallback.changePercent <= -SIM_LIMIT_LOCK_PCT)
      return { status: "rejected", reason: `未成交：讀不到五檔與跌停價，跌幅 ${fallback.changePercent}% 保守視為跌停賣不掉` };
    if (!(fallback.price > 0)) return { status: "rejected", reason: "未成交：讀不到價格" };
    price = fallback.price;
    basis = mode === "fixed" ? `盤後定價：收盤價 ${price}（讀不到五檔，漲跌停用保守規則）` : `最近成交價 ${price}（讀不到五檔，退回成交價）`;
  } else if (mode === "fixed") {
    const close = depth.last ?? fallback.price;
    if (!(close > 0)) return { status: "rejected", reason: "未成交：讀不到收盤價" };
    if (buy && depth.limitUp != null && close >= depth.limitUp) return { status: "rejected", reason: `未成交：收盤漲停 ${depth.limitUp}（鎖死，盤後定價視為買不到）` };
    if (!buy && depth.limitDown != null && close <= depth.limitDown) return { status: "rejected", reason: `未成交：收盤跌停 ${depth.limitDown}（鎖死，盤後定價視為賣不掉）` };
    price = close;
    basis = `盤後定價：當日收盤價 ${close}（${SIM_FIXED_FILL_TIME} 撮合）`;
  } else {
    const last = depth.last ?? fallback.price;
    if (buy) {
      if (depth.limitUp != null && last >= depth.limitUp && depth.bestAsk == null)
        return { status: "rejected", reason: `未成交：漲停鎖死（現價＝漲停 ${depth.limitUp}、賣方無掛單）` };
      price = depth.bestAsk ?? last;
      basis = depth.bestAsk != null ? `最佳賣價 ${price}` : `最近成交價 ${price}（沒有賣方五檔）`;
    } else {
      if (depth.limitDown != null && last <= depth.limitDown && depth.bestBid == null)
        return { status: "rejected", reason: `未成交：跌停鎖死（現價＝跌停 ${depth.limitDown}、買方無掛單）` };
      price = depth.bestBid ?? last;
      basis = depth.bestBid != null ? `最佳買價 ${price}` : `最近成交價 ${price}（沒有買方五檔）`;
    }
    if (!(price > 0)) return { status: "rejected", reason: "未成交：讀不到價格" };
  }
  let shares = order.shares;
  const vol = depth?.volumeShares ?? 0;
  if (vol > 0) {
    const cap = Math.floor(vol * SIM_MAX_VOLUME_SHARE);
    if (cap <= 0) return { status: "rejected", reason: `未成交：當日成交量只有 ${fmtShares(vol)} 股，單筆上限 ${SIM_MAX_VOLUME_SHARE * 100}% 不到 1 股` };
    if (shares > cap) {
      basis += `；部分成交 ${fmtShares(cap)}／${fmtShares(shares)} 股（上限＝當日成交量 ${fmtShares(vol)} 股的 ${SIM_MAX_VOLUME_SHARE * 100}%）`;
      shares = cap;
    }
  }
  if (mode === "fixed" && shares % SIM_BOARD_LOT !== 0)
    basis += `；零股 ${fmtShares(shares % SIM_BOARD_LOT)} 股走盤後零股，以收盤價近似（實際撮合價可能不同）`;
  return { status: "filled", price, shares, basis };
}

/** 未成交也記一筆（不動現金與持股），交易紀錄顯示原因；下一個時點重新評估，不續掛。 */
export function recordRejected(state: SimState, order: SimOrder, reason: string, ctx: { at: string; day: string; slot: SimSlotId }): SimTrade {
  const t: SimTrade = {
    at: ctx.at,
    day: ctx.day,
    slot: ctx.slot,
    symbol: order.symbol,
    name: order.name,
    side: order.side,
    shares: order.shares,
    price: order.price,
    amount: 0,
    fee: 0,
    ratingLabel: order.ratingLabel,
    reason: order.reason,
    status: "rejected",
    rejectReason: reason,
  };
  pushTrade(state, t);
  return t;
}

/**
 * 依序撮合一批單（純函式、會修改 state）：decideFill 決定能不能成交與價格股數，買單再依現金縮到買得起；
 * 回傳成交與未成交筆數。`depthOf` 回 null＝讀不到盤口（退回保守規則）。
 */
export function executeSimOrders(
  state: SimState,
  orders: SimOrder[],
  opts: {
    mode: "continuous" | "fixed";
    depthOf: (symbol: string) => SimDepth | null;
    fallbackOf: (symbol: string) => { price: number; changePercent: number };
    ctx: { at: string; day: string; slot: SimSlotId; index: number | null };
  }
): { filled: SimTrade[]; rejected: SimTrade[] } {
  const filled: SimTrade[] = [];
  const rejected: SimTrade[] = [];
  for (const o of orders) {
    const fb = opts.fallbackOf(o.symbol);
    const d = decideFill(o, opts.depthOf(o.symbol), opts.mode, { price: fb.price || o.price, changePercent: fb.changePercent });
    if (d.status === "rejected") {
      rejected.push(recordRejected(state, o, d.reason, opts.ctx));
      continue;
    }
    let shares = d.shares;
    if (o.side === "buy") shares = Math.min(shares, sharesForBudget(state.cash, d.price));
    if (o.side === "sell") shares = Math.min(shares, state.holdings.find((h) => h.symbol === o.symbol)?.shares ?? 0);
    if (shares <= 0) {
      rejected.push(recordRejected(state, o, o.side === "buy" ? "未成交：成交價高於預估，現金不足" : "未成交：已無持股", opts.ctx));
      continue;
    }
    const t = applySimOrder(state, { ...o, price: d.price, shares }, opts.ctx, d.basis);
    if (t) filled.push(t);
  }
  return { filled, rejected };
}

/** 13:35 那輪的單 → 盤後定價委託。 */
export function toPendingOrders(orders: SimOrder[], ctx: { day: string; at: string; slot: SimSlotId }): SimPendingOrder[] {
  return orders.map((o) => ({
    day: ctx.day,
    decidedAt: ctx.at,
    slot: ctx.slot,
    symbol: o.symbol,
    name: o.name,
    side: o.side,
    shares: o.shares,
    refPrice: o.price,
    ratingLabel: o.ratingLabel,
    reason: o.reason,
    ...(o.reduce ? { reduce: true } : {}),
    ...(o.add ? { add: true } : {}),
  }));
}

export function pendingToOrder(p: SimPendingOrder): SimOrder {
  return { symbol: p.symbol, name: p.name, side: p.side, shares: p.shares, price: p.refPrice, ratingLabel: p.ratingLabel, reason: p.reason, reduce: p.reduce, add: p.add };
}

/** 盤後定價成交時間（台北 day 14:30）的 ISO。 */
export function fixedFillAt(day: string): string {
  return new Date(`${day}T${SIM_FIXED_FILL_TIME}:00+08:00`).toISOString();
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
