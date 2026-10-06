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
import { misRowToDepth } from "@/lib/simPortfolio/depth";
import {
  decideFill,
  executeSimOrders,
  fixedFillAt,
  pendingToOrder,
  recordRejected,
  SIM_MAX_VOLUME_SHARE,
  toPendingOrders,
  type SimDepth,
} from "@/lib/simPortfolio/rules";
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
  it("空手：依名單順序買建議買進的，每檔約 15% 淨值；先不要買的不買（漲停能不能買由 decideFill 判斷）", () => {
    const s = newSimState(tpe(DAY, "09:30"), { etf: 100, index: 20000 });
    const orders = planSimOrders({
      state: s,
      day: DAY,
      held: [],
      candidates: [cand("1101", 50), cand("2330", 1500), cand("9999", 30, 1, "avoid"), cand("8888", 40, 9.8)],
      prices: new Map(),
    });
    expect(orders.map((o) => o.symbol)).toEqual(["1101", "2330", "8888"]);
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
  it("當天賣掉的不買回（未成交的賣單不算賣過）", () => {
    const s = newSimState(tpe("2026-10-05", "09:30"), { etf: 100, index: 20000 });
    applySimOrder(s, { symbol: "A", name: "A", side: "buy", shares: 1000, price: 50, ratingLabel: "", reason: "" }, ctx("2026-10-05"));
    recordRejected(s, { symbol: "A", name: "A", side: "sell", shares: 1000, price: 45, ratingLabel: "", reason: "" }, "未成交：跌停鎖死", ctx());
    expect(s.holdings).toHaveLength(1);
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

const depth = (over: Partial<SimDepth> = {}): SimDepth => ({
  last: 100,
  prevClose: 95,
  limitUp: 104.5,
  limitDown: 85.5,
  bestAsk: 100.5,
  bestAskVol: 5000,
  bestBid: 99.5,
  bestBidVol: 5000,
  volumeShares: 10_000_000,
  tradeDate: DAY,
  ...over,
});
const fb = { price: 100, changePercent: 1 };

describe("成交判斷（漲跌停鎖死、五檔、成交量）", () => {
  it("盤中：買用最佳賣價、賣用最佳買價", () => {
    expect(decideFill({ side: "buy", shares: 100 }, depth(), "continuous", fb)).toMatchObject({ status: "filled", price: 100.5, shares: 100 });
    expect(decideFill({ side: "sell", shares: 100 }, depth(), "continuous", fb)).toMatchObject({ status: "filled", price: 99.5 });
  });
  it("漲停鎖死（現價＝漲停、賣方無掛單）買不到；漲停但還有賣單可以買", () => {
    const locked = decideFill({ side: "buy", shares: 100 }, depth({ last: 104.5, bestAsk: null }), "continuous", fb);
    expect(locked.status).toBe("rejected");
    expect(locked.status === "rejected" && locked.reason).toContain("漲停鎖死");
    expect(decideFill({ side: "buy", shares: 100 }, depth({ last: 104.5, bestAsk: 104.5 }), "continuous", fb)).toMatchObject({ status: "filled", price: 104.5 });
    // 漲停鎖死時賣出照樣可以（用最佳買價）
    expect(decideFill({ side: "sell", shares: 100 }, depth({ last: 104.5, bestAsk: null, bestBid: 104.5 }), "continuous", fb)).toMatchObject({ status: "filled", price: 104.5 });
  });
  it("跌停鎖死（現價＝跌停、買方無掛單）賣不掉", () => {
    const d = decideFill({ side: "sell", shares: 100 }, depth({ last: 85.5, bestBid: null }), "continuous", fb);
    expect(d.status === "rejected" && d.reason).toContain("跌停鎖死");
  });
  it("盤後定價：收盤價成交；收盤漲停買不到、收盤跌停賣不掉；零股註明近似", () => {
    expect(decideFill({ side: "buy", shares: 1500 }, depth(), "fixed", fb)).toMatchObject({ status: "filled", price: 100, shares: 1500 });
    const odd = decideFill({ side: "buy", shares: 1500 }, depth(), "fixed", fb);
    expect(odd.status === "filled" && odd.basis).toContain("盤後零股");
    expect(decideFill({ side: "buy", shares: 1000 }, depth({ last: 104.5 }), "fixed", fb).status).toBe("rejected");
    expect(decideFill({ side: "sell", shares: 1000 }, depth({ last: 85.5 }), "fixed", fb).status).toBe("rejected");
    expect(decideFill({ side: "sell", shares: 1000 }, depth({ last: 104.5 }), "fixed", fb)).toMatchObject({ status: "filled", price: 104.5 });
  });
  it("讀不到五檔：退回保守規則並寫明原因", () => {
    expect(decideFill({ side: "buy", shares: 100 }, null, "continuous", { price: 50, changePercent: 9.6 }).status).toBe("rejected");
    expect(decideFill({ side: "sell", shares: 100 }, null, "continuous", { price: 50, changePercent: -9.6 }).status).toBe("rejected");
    const ok = decideFill({ side: "buy", shares: 100 }, null, "continuous", { price: 50, changePercent: 3 });
    expect(ok).toMatchObject({ status: "filled", price: 50 });
    expect(ok.status === "filled" && ok.basis).toContain("讀不到五檔");
  });
  it("單筆超過當日成交量 5% 只部分成交；量太少不成交", () => {
    const d = decideFill({ side: "buy", shares: 10_000 }, depth({ volumeShares: 100_000 }), "continuous", fb);
    expect(d).toMatchObject({ status: "filled", shares: 100_000 * SIM_MAX_VOLUME_SHARE });
    expect(d.status === "filled" && d.basis).toContain("部分成交");
    expect(decideFill({ side: "buy", shares: 10 }, depth({ volumeShares: 10 }), "continuous", fb).status).toBe("rejected");
  });
  it("MIS 列解析：漲跌停、五檔、量（張→股）", () => {
    const d = misRowToDepth({ c: "2330", z: "-", trade: { z: "1000" }, y: "990", u: "1085", w: "895", a: "1005_1010_", b: "-", f: "3_4_", g: "", v: "12345", d: "20261006" })!;
    expect(d).toMatchObject({ last: 1000, limitUp: 1085, limitDown: 895, bestAsk: 1005, bestAskVol: 3000, bestBid: null, volumeShares: 12_345_000, tradeDate: "2026-10-06" });
  });
});

describe("撮合與盤後委託", () => {
  it("未成交記一筆、不動現金與持股；成交附成交依據", () => {
    const s = newSimState(tpe(DAY, "09:30"), { etf: 100, index: 20000 });
    const orders = [
      { symbol: "A", name: "A", side: "buy" as const, shares: 100, price: 100, ratingLabel: "建議買進", reason: "r" },
      { symbol: "B", name: "B", side: "buy" as const, shares: 100, price: 100, ratingLabel: "建議買進", reason: "r" },
    ];
    const res = executeSimOrders(s, orders, {
      mode: "continuous",
      depthOf: (sym) => (sym === "A" ? depth() : depth({ last: 104.5, bestAsk: null })),
      fallbackOf: () => fb,
      ctx: { ...ctx(), index: 20000 },
    });
    expect(res.filled.map((t) => t.symbol)).toEqual(["A"]);
    expect(res.filled[0]).toMatchObject({ price: 100.5, status: "filled", basis: "最佳賣價 100.5" });
    expect(res.rejected[0]).toMatchObject({ symbol: "B", status: "rejected", amount: 0, fee: 0 });
    expect(s.cash).toBe(SIM_INITIAL_CAPITAL - Math.round(100.5 * 100) - buyFee(100.5, 100));
    expect(s.trades).toHaveLength(2);
    expect(s.stats.buys).toBe(1);
  });
  it("成交價高於預估時買單縮到現金買得起", () => {
    const s = newSimState(tpe(DAY, "09:30"), { etf: 100, index: 20000 });
    s.cash = 10_000;
    const res = executeSimOrders(s, [{ symbol: "A", name: "A", side: "buy", shares: 100, price: 99, ratingLabel: "", reason: "" }], {
      mode: "continuous",
      depthOf: () => depth(),
      fallbackOf: () => fb,
      ctx: ctx(),
    });
    expect(res.filled[0].shares).toBe(sharesForBudget(10_000, 100.5));
    expect(s.cash).toBeGreaterThanOrEqual(0);
  });
  it("13:35 委託 → 14:35 以收盤價結算、成交時間 14:30", () => {
    const s = newSimState(tpe(DAY, "09:30"), { etf: 100, index: 20000 });
    const pend = toPendingOrders([{ symbol: "A", name: "A", side: "buy", shares: 1000, price: 100, ratingLabel: "建議買進", reason: "r" }], { day: DAY, at: "x", slot: "1335" });
    const res = executeSimOrders(s, pend.map(pendingToOrder), {
      mode: "fixed",
      depthOf: () => depth({ last: 101 }),
      fallbackOf: () => fb,
      ctx: { at: fixedFillAt(DAY), day: DAY, slot: "1435", index: 20000 },
    });
    expect(res.filled[0]).toMatchObject({ price: 101, shares: 1000, at: "2026-10-06T06:30:00.000Z" });
    expect(currentSimSlot(tpe(DAY, "14:00"))?.kind).toBe("fixed-decide");
    expect(currentSimSlot(tpe(DAY, "14:31"))).toBeNull();
    expect(currentSimSlot(tpe(DAY, "14:35"))?.kind).toBe("fixed-settle");
  });
});

describe("決策說明（封存用，不影響決策）", () => {
  it("候選逐檔寫下選或不選的原因、持股寫下動或不動的原因", () => {
    const s = newSimState(tpe("2026-10-05", "09:30"), { etf: 100, index: 20000 });
    for (let i = 0; i < SIM_MAX_POSITIONS - 1; i++)
      applySimOrder(s, { symbol: `H${i}`, name: "x", side: "buy", shares: 100, price: 100, ratingLabel: "", reason: "" }, ctx("2026-10-05"));
    const explain = new Map<string, string>();
    const held: HeldReview[] = [{ symbol: "H0", price: 100, changePercent: 0, rating: rating("buy", "hold"), newStop: 90 }];
    const orders = planSimOrders({
      state: s,
      day: DAY,
      held,
      candidates: [cand("N1", 50), cand("N2", 50), cand("N3", 50, 1, "avoid"), cand("H1", 100)],
      prices: new Map(),
      explain,
    });
    expect(orders.map((o) => o.symbol)).toEqual(["N1"]);
    expect(explain.get("c:N1")).toContain("買進");
    expect(explain.get("c:N2")).toContain("持股已滿");
    expect(explain.get("c:N3")).toContain("不是建議買進");
    expect(explain.get("c:H1")).toContain("已持有");
    expect(explain.get("h:H0")).toContain("續抱");
  });
});
