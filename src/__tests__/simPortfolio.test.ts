import { describe, expect, it } from "vitest";
import {
  applySimOrder,
  buyFee,
  computePerformance,
  currentSimSlot,
  halfShares,
  markSlotDone,
  maxDrawdownPct,
  newSimState,
  planSimOrders,
  sellFee,
  sharesForBudget,
  SIM_INITIAL_CAPITAL,
  SIM_MAX_POSITIONS,
  SIM_NEW_POSITION_PCT,
  slotDoneKey,
  upsertNavPoint,
  type BuyCandidate,
  type HeldReview,
} from "@/lib/simPortfolio/rules";
import { buildReviewFacts } from "@/lib/simPortfolio/review";
import { TRADE_COST_PCT, tradeReward } from "@/lib/ai/learning/reward";
import { TW_ROUND_TRIP_COST_PCT } from "@/lib/tradingCosts";
import { computeHoldingPnl } from "@/lib/portfolio";
import type { HoldingCode, SiteRating } from "@/lib/ai/siteRating";

const rating = (code: SiteRating["code"], holdingCode: HoldingCode = "hold"): SiteRating => ({
  code,
  label: code === "buy" ? "建議買進" : "建議先不要買",
  holdingCode,
  holdingLabel: { add: "可分批加碼", hold: "續抱", reduce: "建議減碼", exit: "建議出場" }[holdingCode],
  reason: "程式理由",
  supportCount: 3,
  againstCount: 0,
  zone: null,
  noChase: null,
  exit: null,
  chaseHits: [],
  riskNote: null,
});

/** 台北時間 → Date（台北 UTC+8）。2026-10-06 是週二。 */
const tpe = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+08:00`);
const DAY = "2026-10-06";
const ctx = (day = DAY) => ({ at: `${day}T02:00:00.000Z`, day, slot: "0930" as const, index: 20000 });
const cand = (symbol: string, price: number, changePercent = 1, code: SiteRating["code"] = "buy"): BuyCandidate => ({ symbol, name: `股${symbol}`, price, changePercent, rating: rating(code) });

describe("交易成本：唯一來源", () => {
  it("學習獎勵的來回成本＝費率加總", () => {
    expect(TW_ROUND_TRIP_COST_PCT).toBe(0.585);
    expect(TRADE_COST_PCT).toBe(0.585);
  });
  it("手續費與證交稅逐項無條件捨去，跟關注清單損益同一套", () => {
    expect(buyFee(100, 1000)).toBe(142); // 100000×0.001425＝142.5
    expect(sellFee(110, 1000)).toBe(156 + 330);
    // 模擬組合買 100 賣 110 的已實現損益＝關注清單同股數同價的損益
    const s = newSimState(tpe("2026-10-05", "09:30"), { etf: 100, index: 20000 });
    applySimOrder(s, { symbol: "1111", name: "甲", side: "buy", shares: 1000, price: 100, ratingLabel: "建議買進", reason: "r" }, ctx("2026-10-05"));
    const t = applySimOrder(s, { symbol: "1111", name: "甲", side: "sell", shares: 1000, price: 110, ratingLabel: "建議出場", reason: "r" }, ctx())!;
    expect(t.realized).toBe(computeHoldingPnl(110, 100, 1000, "TW").pnl);
  });
});

describe("股數", () => {
  it("預算內最多股數（含手續費不超出預算）", () => {
    expect(sharesForBudget(150_000, 100)).toBe(1497);
    expect(sharesForBudget(150_000, 1000)).toBe(149);
    const s = sharesForBudget(150_000, 1000);
    expect(s * 1000 + buyFee(1000, s)).toBeLessThanOrEqual(150_000);
    expect(sharesForBudget(0, 10)).toBe(0);
  });
  it("減碼賣一半", () => {
    expect(halfShares(3000)).toBe(1500);
    expect(halfShares(4000)).toBe(2000);
    expect(halfShares(150)).toBe(75);
    expect(halfShares(1)).toBe(1);
  });
});

describe("執行時點", () => {
  it("09:30、13:00、13:35 起；週末與空檔不執行", () => {
    expect(currentSimSlot(tpe(DAY, "09:29"))).toBeNull();
    expect(currentSimSlot(tpe(DAY, "09:30"))?.id).toBe("0930");
    expect(currentSimSlot(tpe(DAY, "12:59"))?.id).toBe("0930");
    expect(currentSimSlot(tpe(DAY, "13:10"))?.id).toBe("1300");
    expect(currentSimSlot(tpe(DAY, "13:32"))).toBeNull();
    expect(currentSimSlot(tpe(DAY, "13:35"))?.id).toBe("1335");
    expect(currentSimSlot(tpe("2026-10-10", "10:00"))).toBeNull(); // 週六
  });
  it("冪等紀錄：同一時點只記一次、只留最近幾筆", () => {
    const s = newSimState(tpe(DAY, "09:30"), { etf: null, index: null });
    markSlotDone(s, DAY, "0930");
    markSlotDone(s, DAY, "0930");
    expect(s.doneSlots).toEqual([slotDoneKey(DAY, "0930")]);
    for (let i = 1; i <= 20; i++) markSlotDone(s, `2026-11-${String(i).padStart(2, "0")}`, "1335");
    expect(s.doneSlots.length).toBeLessThanOrEqual(12);
  });
});

describe("買賣決策（只依評等）", () => {
  it("空手：依名單順序買建議買進的，每檔約 15% 淨值；先不要買、接近漲停的不買", () => {
    const s = newSimState(tpe(DAY, "09:30"), { etf: 100, index: 20000 });
    const orders = planSimOrders({
      state: s,
      day: DAY,
      held: [],
      candidates: [cand("1101", 50), cand("2330", 1500), cand("9999", 30, 1, "avoid"), cand("8888", 40, 9.8)],
      prices: new Map(),
    });
    expect(orders.map((o) => o.symbol)).toEqual(["1101", "2330"]);
    expect(orders[0].shares).toBe(2995); // 15 萬／(50×1.001425)
    expect(orders[1].shares).toBe(Math.floor((SIM_INITIAL_CAPITAL * SIM_NEW_POSITION_PCT) / (1500 * 1.001425)));
  });
  it("持股滿了就不再買", () => {
    const s = newSimState(tpe(DAY, "09:30"), { etf: 100, index: 20000 });
    for (let i = 0; i < SIM_MAX_POSITIONS; i++)
      applySimOrder(s, { symbol: `10${i}`, name: "x", side: "buy", shares: 100, price: 100, ratingLabel: "", reason: "" }, ctx("2026-10-05"));
    const orders = planSimOrders({ state: s, day: DAY, held: [], candidates: [cand("2330", 100)], prices: new Map() });
    expect(orders).toEqual([]);
  });
  it("出場全賣、減碼賣一半且只減一次、跌破上次出場價停損、當天買的不因評等賣", () => {
    const s = newSimState(tpe("2026-10-05", "09:30"), { etf: 100, index: 20000 });
    for (const sym of ["A", "B", "C"]) applySimOrder(s, { symbol: sym, name: sym, side: "buy", shares: 2000, price: 50, ratingLabel: "", reason: "" }, ctx("2026-10-05"));
    applySimOrder(s, { symbol: "D", name: "D", side: "buy", shares: 1000, price: 50, ratingLabel: "", reason: "" }, ctx());
    s.holdings.find((h) => h.symbol === "C")!.stopPrice = 47;
    const held: HeldReview[] = [
      { symbol: "A", price: 49, changePercent: -1, rating: rating("avoid", "exit"), newStop: null },
      { symbol: "B", price: 51, changePercent: 1, rating: rating("avoid", "reduce"), newStop: 48 },
      { symbol: "C", price: 46.5, changePercent: -3, rating: rating("buy", "hold"), newStop: 44 },
      { symbol: "D", price: 48, changePercent: -4, rating: rating("avoid", "exit"), newStop: null },
    ];
    const orders = planSimOrders({ state: s, day: DAY, held, candidates: [], prices: new Map() });
    expect(orders.map((o) => [o.symbol, o.side, o.shares])).toEqual([
      ["A", "sell", 2000],
      ["B", "sell", 1000],
      ["C", "sell", 2000],
    ]);
    for (const o of orders) applySimOrder(s, o, ctx());
    expect(s.holdings.find((h) => h.symbol === "B")).toMatchObject({ shares: 1000, reduced: true });
    const again = planSimOrders({ state: s, day: "2026-10-07", held: [held[1]], candidates: [], prices: new Map() });
    expect(again).toEqual([]);
  });
  it("跌停附近不賣；當天賣掉的不買回", () => {
    const s = newSimState(tpe("2026-10-05", "09:30"), { etf: 100, index: 20000 });
    applySimOrder(s, { symbol: "A", name: "A", side: "buy", shares: 1000, price: 50, ratingLabel: "", reason: "" }, ctx("2026-10-05"));
    const locked = planSimOrders({ state: s, day: DAY, held: [{ symbol: "A", price: 45, changePercent: -9.9, rating: rating("avoid", "exit"), newStop: null }], candidates: [], prices: new Map() });
    expect(locked).toEqual([]);
    applySimOrder(s, { symbol: "A", name: "A", side: "sell", shares: 1000, price: 49, ratingLabel: "", reason: "" }, ctx());
    expect(planSimOrders({ state: s, day: DAY, held: [], candidates: [cand("A", 49)], prices: new Map() })).toEqual([]);
  });
  it("加碼：可分批加碼且不是當天買的，加到單檔上限為止", () => {
    const s = newSimState(tpe("2026-10-05", "09:30"), { etf: 100, index: 20000 });
    applySimOrder(s, { symbol: "A", name: "A", side: "buy", shares: 1500, price: 100, ratingLabel: "", reason: "" }, ctx("2026-10-05"));
    const orders = planSimOrders({ state: s, day: DAY, held: [{ symbol: "A", price: 100, changePercent: 1, rating: rating("buy", "add"), newStop: 92 }], candidates: [], prices: new Map([["A", 100]]) });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ side: "buy", add: true });
    expect(orders[0].shares * 100).toBeLessThanOrEqual(0.05 * SIM_INITIAL_CAPITAL);
  });
  it("現金不夠的買單被拒絕、超過持股的賣單被拒絕", () => {
    const s = newSimState(tpe(DAY, "09:30"), { etf: 100, index: 20000 });
    expect(applySimOrder(s, { symbol: "A", name: "A", side: "buy", shares: 1000, price: 2000, ratingLabel: "", reason: "" }, ctx())).toBeNull();
    expect(applySimOrder(s, { symbol: "A", name: "A", side: "sell", shares: 1, price: 10, ratingLabel: "", reason: "" }, ctx())).toBeNull();
    expect(s.cash).toBe(SIM_INITIAL_CAPITAL);
  });
});

describe("淨值與成效", () => {
  it("淨值＝現金＋持股市值；未實現扣賣出成本；對照 0050 與加權指數", () => {
    const s = newSimState(tpe("2026-10-05", "09:30"), { etf: 100, index: 20000 });
    applySimOrder(s, { symbol: "A", name: "A", side: "buy", shares: 1000, price: 100, ratingLabel: "", reason: "" }, ctx("2026-10-05"));
    expect(s.cash).toBe(SIM_INITIAL_CAPITAL - 100_000 - 142);
    upsertNavPoint(s, { day: "2026-10-05", nav: s.cash + 100_000, cash: s.cash, etf: 100, index: 20000 });
    const p = computePerformance(s, { prices: new Map([["A", 110]]), etf: 105, index: 20200 }, DAY);
    expect(p.nav).toBe(s.cash + 110_000);
    expect(p.unrealized).toBe(110_000 - sellFee(110, 1000) - 100_142);
    expect(p.etfReturnPct).toBe(5);
    expect(p.indexReturnPct).toBe(1);
    expect(p.totalReturnPct).toBeCloseTo(((p.nav / SIM_INITIAL_CAPITAL) - 1) * 100, 2);
    expect(p.vsEtfPct).toBeCloseTo(p.totalReturnPct - 5, 2);
    expect(p.dayReturnPct).toBeCloseTo((p.nav / (s.cash + 100_000) - 1) * 100, 2);
    expect(p.winRatePct).toBeNull();
  });
  it("賣出：已實現、同期大盤、獎勵＝報酬−大盤；勝率", () => {
    const s = newSimState(tpe("2026-10-05", "09:30"), { etf: 100, index: 20000 });
    applySimOrder(s, { symbol: "A", name: "A", side: "buy", shares: 1000, price: 100, ratingLabel: "", reason: "" }, { ...ctx("2026-10-05"), index: 20000 });
    const t = applySimOrder(s, { symbol: "A", name: "A", side: "sell", shares: 1000, price: 110, ratingLabel: "", reason: "" }, { ...ctx(), index: 21000 })!;
    expect(t.indexPct).toBe(5);
    expect(t.reward).toBe(tradeReward(t.realizedPct!, 5));
    expect(s.holdings).toHaveLength(0);
    expect(s.cash).toBe(SIM_INITIAL_CAPITAL + t.realized!);
    const p = computePerformance(s, { prices: new Map(), etf: 100, index: 21000 }, DAY);
    expect(p.winRatePct).toBe(100);
    expect(p.tradeCount).toBe(2);
  });
  it("最大回撤", () => {
    expect(maxDrawdownPct([100, 120, 90, 130, 117])).toBe(25);
    expect(maxDrawdownPct([100, 101, 102])).toBe(0);
  });
  it("淨值點同一天覆寫", () => {
    const s = newSimState(tpe(DAY, "09:30"), { etf: null, index: null });
    upsertNavPoint(s, { day: DAY, nav: 1, cash: 1, etf: null, index: null });
    upsertNavPoint(s, { day: DAY, nav: 2, cash: 2, etf: null, index: null });
    expect(s.nav).toEqual([{ day: DAY, nav: 2, cash: 2, etf: null, index: null }]);
  });
  it("檢討事實：列出今日交易、需檢討的虧損持股", () => {
    const s = newSimState(tpe("2026-10-05", "09:30"), { etf: 100, index: 20000 });
    applySimOrder(s, { symbol: "A", name: "甲", side: "buy", shares: 1000, price: 100, ratingLabel: "建議買進", reason: "法人買超" }, ctx());
    const prices = new Map([["A", 90]]);
    const facts = buildReviewFacts(s, computePerformance(s, { prices, etf: 100, index: 20000 }, DAY), prices, DAY);
    expect(facts).toContain("買進 甲(A) 1,000 股 @ 100");
    expect(facts).toContain("需檢討");
  });
});
