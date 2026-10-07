import { getChart, getIndices, getQuote, getQuotesBatch } from "@/lib/data";
import type { Candle } from "@/lib/data/types";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { getActionBrief } from "@/lib/ai/actionBrief";
import { getStockRating, type StockRatingResult } from "@/lib/ai/stockRating";
import { describeRatingForHolding } from "@/lib/ai/holdingRating";
import { computeHoldingStop } from "@/lib/ai/holdingStop";
import { getSimDepth } from "./depth";
import { appendSimArchive, ratingSnapshot, type SimArchivedTrade, type SimDecisionItem, type SimRatingSnapshot } from "./archive";
import {
  computePerformance,
  currentSimSlot,
  executeSimOrders,
  fixedFillAt,
  markSlotDone,
  newSimState,
  pendingToOrder,
  planSimOrders,
  recordRejected,
  sellFee,
  SIM_BENCHMARK_ETF,
  SIM_LEVERAGED_ETF,
  ensureLevBase,
  SIM_FIXED_FILL_TIME,
  SIM_MAX_REVIEWS,
  slotDoneKey,
  toPendingOrders,
  upsertNavPoint,
  type BuyCandidate,
  type HeldReview,
  type SimDepth,
  type SimPlanExplain,
  type SimSlotDef,
} from "./rules";
import { acquireSimLock, readSimState, releaseSimLock, simStoreEnabled, writeSimState } from "./store";
import { writeSimReview } from "./review";
import type { SimSlotId, SimState, SimTrade } from "./types";

/**
 * AI 模擬投資組合的執行（有 I/O）。由 /api/cron/warm-cache（cron-job.org 每 5 分鐘）順帶呼叫，
 * 不在執行時點時零 Redis 指令直接略過；也可手動打 /api/cron/sim-portfolio。
 * 買賣規則、成交判斷全在 rules.ts（純函式）；這裡只負責抓評等／報價／盤口、套用、存檔。
 * 時點：盤中 09:30、13:00 立即撮合；13:35 下盤後定價委託；14:35 起以收盤價結算（成交時間 14:30）並寫 AI 檢討。
 */

export interface SimRunResult {
  status: "done" | "skipped" | "disabled" | "failed";
  reason?: string;
  slot?: SimSlotId;
  nav?: number;
}

/** 本執行個體已確認做完的時點（避免同一時點窗口內每 5 分鐘都讀一次 Redis）。 */
const doneMemo = new Set<string>();

const TAIEX_SYMBOL = "TAIEX";

async function dailyCandles(symbol: string): Promise<Candle[]> {
  const chart = await getChart(symbol, "3m", "TW").catch(() => null);
  return chart?.candles ?? [];
}

/** 持有中一檔：評等（source＝sim-portfolio 記進評等紀錄）→ 套成本（停利）→ 持有中出場價。 */
async function reviewHolding(
  h: SimState["holdings"][number],
  price: number,
  changePercent: number
): Promise<{ review: HeldReview; rated: StockRatingResult } | null> {
  const rated = await getStockRating(h.symbol, "TW", "sim-portfolio").catch(() => null);
  if (!rated) return null;
  const p = price > 0 ? price : rated.price;
  const candles = await dailyCandles(h.symbol);
  // 停利檢查只看買進日之後的日K（買進日已知，比關注清單的近似更準）；出場價用完整 3 個月日K（MA20 等支撐）。
  const sinceBuy = candles.filter((c) => c.time.slice(0, 10) >= h.buyDay);
  const held = describeRatingForHolding({ name: rated.name, symbol: h.symbol, price: p, rating: rated.rating }, { costBasis: h.avgCost, buyDate: h.buyDay, market: "TW" }, sinceBuy);
  const stop = computeHoldingStop({ candles, price: p, costBasis: h.avgCost, market: "TW" });
  return { review: { symbol: h.symbol, price: p, changePercent, rating: held.rating, newStop: stop?.price ?? null }, rated };
}

/** 存這次的持有中出場價（下一個時點比對）與最後價格；這次沒有檢視結果的持股（新買進）用日K另算一次。 */
async function refreshStops(
  state: SimState,
  prices: Map<string, number>,
  stopBySymbol: Map<string, number | null>,
  candidates: BuyCandidate[] = []
): Promise<void> {
  for (const h of state.holdings) {
    const p = prices.get(h.symbol);
    if (p && p > 0) h.lastPrice = p;
    if (stopBySymbol.has(h.symbol)) {
      h.stopPrice = stopBySymbol.get(h.symbol) ?? null;
      continue;
    }
    const candles = await dailyCandles(h.symbol);
    h.stopPrice = computeHoldingStop({ candles, price: p ?? h.avgCost, costBasis: h.avgCost, market: "TW" })?.price ?? h.stopPrice ?? null;
    h.lastLabel = candidates.find((c) => c.symbol === h.symbol)?.rating.holdingLabel ?? h.lastLabel;
  }
}

/** 盤口只用今天的（MIS 資料日期不是今天＝重置／測試狀態，視同讀不到）。 */
function todayDepth(depth: Map<string, SimDepth>, day: string) {
  return (sym: string): SimDepth | null => {
    const d = depth.get(sym);
    return d && d.tradeDate === day ? d : null;
  };
}

export async function runSimPortfolio(opts: { now?: Date; slot?: SimSlotDef | null } = {}): Promise<SimRunResult> {
  if (!simStoreEnabled) return { status: "disabled", reason: "沒有 Redis" };
  const now = opts.now ?? new Date();
  const slot = opts.slot ?? currentSimSlot(now);
  if (!slot) return { status: "skipped", reason: "不在執行時點（盤中 09:30、13:00；13:35 下盤後委託；14:35 結算）" };
  const day = taipeiDayKey(now);
  const doneKey = slotDoneKey(day, slot.id);
  if (doneMemo.has(doneKey)) return { status: "skipped", reason: "這個時點已執行過", slot: slot.id };
  const first = await readSimState();
  if (first?.doneSlots.includes(doneKey)) {
    doneMemo.add(doneKey);
    return { status: "skipped", reason: "這個時點已執行過", slot: slot.id };
  }
  if (!(await acquireSimLock())) return { status: "skipped", reason: "另一個執行中", slot: slot.id };
  try {
    let state = await readSimState();
    if (state?.doneSlots.includes(doneKey)) {
      doneMemo.add(doneKey);
      return { status: "skipped", reason: "這個時點已執行過", slot: slot.id };
    }
    const [etfQuote, levQuote, indices] = await Promise.all([
      getQuote(SIM_BENCHMARK_ETF, "TW").catch(() => null),
      getQuote(SIM_LEVERAGED_ETF, "TW").catch(() => null), // 00631L 只是第二個對照，抓不到不影響交易（那一點 lev 記 null）
      getIndices().catch(() => []),
    ]);
    const levPrice = levQuote && levQuote.price > 0 ? levQuote.price : null;
    if (!etfQuote) return { status: "failed", reason: "抓不到 0050 報價（下一次預熱再試）", slot: slot.id };
    const index = indices.find((i) => i.symbol === TAIEX_SYMBOL)?.price ?? null;
    // 國定假日：報價的交易日不是今天就不交易（只記為已執行）。
    if (etfQuote.tradeDate && etfQuote.tradeDate !== day) {
      if (state) {
        markSlotDone(state, day, slot.id);
        state.lastRun = { at: now.toISOString(), slot: slot.id, day, note: `今日非交易日（報價日期 ${etfQuote.tradeDate}），不交易` };
        await writeSimState(state);
      }
      doneMemo.add(doneKey);
      return { status: "skipped", reason: `今日非交易日（報價日期 ${etfQuote.tradeDate}）`, slot: slot.id };
    }
    if (!state) state = newSimState(now, { etf: etfQuote.price, index, lev: levPrice, ...(levPrice != null ? { levFromDay: day } : {}) });
    else ensureLevBase(state, levPrice, day); // 舊資料沒有 00631L 基準價：從第一次抓得到那天起算
    const at = now.toISOString();

    // 這一輪要封存的交易（含未成交）、決策說明、評等快照、盤口。
    const archived: SimArchivedTrade[] = [];
    const snaps = new Map<string, SimRatingSnapshot>();
    let depthUsed: (sym: string) => SimDepth | null = () => null;
    const decisionCands: SimDecisionItem[] = [];
    const decisionHolds: SimDecisionItem[] = [];
    let orderCount = 0;
    const archive = (ts: SimTrade[], extra: Partial<SimArchivedTrade> = {}) => {
      for (const t of ts) archived.push({ ...t, rating: snaps.get(t.symbol) ?? null, depth: depthUsed(t.symbol), ...extra });
    };

    // 封存上線前已在 state 裡的交易（2026-10-06 第一天的 6 筆）補進封存一次（沒有決策快照）。
    if (!state.archiveBackfilled) {
      archived.push(...[...state.trades].reverse().map((t) => ({ ...t, rating: null, depth: null })));
      state.archiveBackfilled = true;
    }

    // 前一天沒結算到的盤後委託：不再成交（收盤價已不是當天的），記為未成交後取消。
    for (const p of (state.pending ?? []).filter((x) => x.day !== day)) {
      const t = recordRejected(state, pendingToOrder(p), "未成交：錯過當天 14:30 結算（系統當天沒有執行到結算時點），委託取消", {
        at: fixedFillAt(p.day),
        day: p.day,
        slot: p.slot,
      });
      archived.push({ ...t, rating: p.rating ?? null, depth: null, decidedAt: p.decidedAt });
    }
    state.pending = (state.pending ?? []).filter((x) => x.day === day);

    let note: string;
    let prices = new Map<string, number>();
    let writeReview = false;
    if (slot.kind === "fixed-settle") {
      // 14:35 起：以當日收盤價結算 13:35 那輪的盤後定價委託，成交時間記 14:30。
      const pend = state.pending;
      state.pending = [];
      const symbols = [...new Set([...pend.map((x) => x.symbol), ...state.holdings.map((h) => h.symbol)])];
      const [depth, quotes] = await Promise.all([
        getSimDepth(symbols),
        getQuotesBatch(symbols.map((symbol) => ({ market: "TW" as const, symbol }))).catch(() => symbols.map(() => null)),
      ]);
      const quoteOf = new Map(symbols.map((sym, i) => [sym, quotes[i]]));
      const depthOf = todayDepth(depth, day);
      depthUsed = depthOf;
      const res = executeSimOrders(state, pend.map(pendingToOrder), {
        mode: "fixed",
        depthOf,
        fallbackOf: (sym) => ({ price: quoteOf.get(sym)?.price ?? 0, changePercent: quoteOf.get(sym)?.changePercent ?? 0 }),
        ctx: { at: fixedFillAt(day), day, slot: slot.id, index },
      });
      for (const sym of symbols) {
        const close = depthOf(sym)?.last ?? quoteOf.get(sym)?.price;
        if (close && close > 0) prices.set(sym, close);
      }
      await refreshStops(state, prices, new Map(state.holdings.filter((h) => !res.filled.some((t) => t.symbol === h.symbol)).map((h) => [h.symbol, h.stopPrice])));
      for (const p of pend) if (p.rating) snaps.set(p.symbol, p.rating);
      const decidedAt = new Map(pend.map((p) => [p.symbol, p.decidedAt]));
      for (const t of [...res.filled, ...res.rejected]) archive([t], { decidedAt: decidedAt.get(t.symbol) });
      for (const t of [...res.filled, ...res.rejected])
        decisionHolds.push({
          symbol: t.symbol,
          name: t.name,
          label: t.ratingLabel,
          action: `盤後定價${t.side === "buy" ? "買進" : "賣出"}結算`,
          why: t.status === "rejected" ? (t.rejectReason ?? "未成交") : `成交 ${t.shares} 股 @ ${t.price}（${t.basis ?? ""}）`,
        });
      orderCount = pend.length;
      note = `${slot.label}：盤後委託 ${pend.length} 筆，成交 ${res.filled.length} 筆、未成交 ${res.rejected.length} 筆（成交時間 ${SIM_FIXED_FILL_TIME}）`;
      writeReview = true;
    } else {
      // 買進候選＝今日建議名單（程式依本站綜合評等選出、已有凍結時段穩定機制），只取台股、評等即時重讀。
      const brief = await getActionBrief().catch(() => null);
      const pickSymbols = (brief?.picks ?? []).filter((x) => x.code === "buy").map((x) => x.symbol.toUpperCase());
      const heldSymbols = state.holdings.map((h) => h.symbol);
      const symbols = [...new Set([...heldSymbols, ...pickSymbols])];
      const quotes = await getQuotesBatch(symbols.map((symbol) => ({ market: "TW" as const, symbol }))).catch(() => symbols.map(() => null));
      const quoteOf = new Map(symbols.map((sym, i) => [sym, quotes[i]]));

      const held: HeldReview[] = [];
      for (const h of state.holdings) {
        const q = quoteOf.get(h.symbol);
        const r = await reviewHolding(h, q?.price ?? 0, q?.changePercent ?? 0);
        if (r) {
          held.push(r.review);
          h.lastLabel = r.review.rating.holdingLabel;
          snaps.set(h.symbol, ratingSnapshot(r.rated, r.review.rating.holdingLabel));
        } else decisionHolds.push({ symbol: h.symbol, name: h.name, label: h.lastLabel ?? "—", action: "—", why: "這個時點讀不到評等，不動作" });
      }
      const candidates: BuyCandidate[] = [];
      for (const sym of pickSymbols) {
        if (heldSymbols.includes(sym)) continue;
        const rated = await getStockRating(sym, undefined, "sim-portfolio").catch(() => null);
        if (!rated || rated.market !== "TW") {
          decisionCands.push({ symbol: sym, name: rated?.name ?? sym, label: "—", action: "—", why: rated ? "不是台股" : "讀不到評等" });
          continue;
        }
        snaps.set(sym, ratingSnapshot(rated));
        const q = quoteOf.get(sym);
        candidates.push({ symbol: sym, name: rated.name, price: q?.price && q.price > 0 ? q.price : rated.price, changePercent: q?.changePercent ?? 0, rating: rated.rating });
      }

      prices = new Map<string, number>();
      for (const r of held) prices.set(r.symbol, r.price);
      for (const c of candidates) prices.set(c.symbol, c.price);
      const changeOf = new Map<string, number>([...held.map((r) => [r.symbol, r.changePercent] as const), ...candidates.map((c) => [c.symbol, c.changePercent] as const)]);
      const explain: SimPlanExplain = new Map();
      const orders = planSimOrders({ state, day, held, candidates, prices, explain });
      orderCount = orders.length;
      const fillNote = new Map<string, string>();
      const tail = brief ? "" : "（今日建議名單暫時抓不到，只檢視持股）";
      if (slot.kind === "fixed-decide") {
        // 13:35～14:29：盤後定價／盤後零股委託，14:35 那輪以收盤價結算。
        state.pending = toPendingOrders(orders, { day, at, slot: slot.id }).map((p) => ({ ...p, rating: snaps.get(p.symbol) ?? null }));
        for (const o of orders) fillNote.set(o.symbol, `盤後定價委託 ${o.shares} 股，${SIM_FIXED_FILL_TIME} 以收盤價成交`);
        note = `${slot.label}：檢視持股 ${held.length} 檔、候選 ${candidates.length} 檔，盤後定價委託 ${orders.length} 筆（${SIM_FIXED_FILL_TIME} 以收盤價成交）${tail}`;
      } else {
        const depth = orders.length > 0 ? await getSimDepth([...new Set(orders.map((o) => o.symbol))]) : new Map<string, SimDepth>();
        depthUsed = todayDepth(depth, day);
        const res = executeSimOrders(state, orders, {
          mode: "continuous",
          depthOf: depthUsed,
          fallbackOf: (sym) => ({ price: prices.get(sym) ?? 0, changePercent: changeOf.get(sym) ?? 0 }),
          ctx: { at, day, slot: slot.id, index },
        });
        archive([...res.filled, ...res.rejected]);
        for (const t of [...res.filled, ...res.rejected])
          fillNote.set(t.symbol, t.status === "rejected" ? (t.rejectReason ?? "未成交") : `成交 ${t.shares} 股 @ ${t.price}（${t.basis ?? ""}）`);
        note = `${slot.label}：檢視持股 ${held.length} 檔、候選 ${candidates.length} 檔，成交 ${res.filled.length} 筆、未成交 ${res.rejected.length} 筆${tail}`;
      }
      const actionOf = (sym: string) => {
        const o = orders.find((x) => x.symbol === sym);
        if (!o) return "—";
        const verb = o.side === "sell" ? (o.reduce ? "減碼" : "賣出") : o.add ? "加碼" : "買進";
        return slot.kind === "fixed-decide" ? `盤後委託${verb}` : verb;
      };
      const withFill = (sym: string, base: string | undefined) => [base ?? "—", fillNote.get(sym)].filter(Boolean).join("；");
      for (const r of held) {
        const h = state.holdings.find((x) => x.symbol === r.symbol) ?? { name: r.symbol };
        decisionHolds.push({ symbol: r.symbol, name: h.name, label: r.rating.holdingLabel, action: actionOf(r.symbol), why: withFill(r.symbol, explain.get(`h:${r.symbol}`)) });
      }
      for (const c of candidates)
        decisionCands.push({ symbol: c.symbol, name: c.name, label: c.rating.label, action: actionOf(c.symbol), why: withFill(c.symbol, explain.get(`c:${c.symbol}`)) });
      await refreshStops(state, prices, new Map(held.map((r) => [r.symbol, r.newStop])), candidates);
    }

    const perf = computePerformance(state, { prices, etf: etfQuote.price, index, lev: levPrice }, day);
    upsertNavPoint(state, { day, nav: perf.nav, cash: state.cash, etf: etfQuote.price, lev: levPrice, index });
    markSlotDone(state, day, slot.id);
    state.lastRun = { at, slot: slot.id, day, note };
    if (writeReview) {
      const review = await writeSimReview(state, perf, prices, day, now);
      state.reviews = [review, ...state.reviews.filter((r) => r.day !== day)].slice(0, SIM_MAX_REVIEWS);
    }
    await writeSimState(state);
    doneMemo.add(doneKey);
    await appendSimArchive({
      trades: archived,
      decision: {
        at,
        day,
        slot: slot.id,
        kind: slot.kind,
        note,
        cash: state.cash,
        nav: perf.nav,
        candidates: decisionCands,
        holdings: decisionHolds,
        orders: orderCount,
        filled: archived.filter((t) => t.status !== "rejected").length,
        rejected: archived.filter((t) => t.status === "rejected").length,
      },
      daily: {
        day,
        at,
        nav: perf.nav,
        cash: state.cash,
        etf: etfQuote.price,
        lev: levPrice,
        index,
        holdings: state.holdings.map((h) => {
          const price = prices.get(h.symbol) ?? h.lastPrice ?? h.avgCost;
          const marketValue = Math.round(price * h.shares);
          return { symbol: h.symbol, name: h.name, shares: h.shares, avgCost: h.avgCost, price, marketValue, pnl: marketValue - sellFee(price, h.shares) - h.invested, stopPrice: h.stopPrice, label: h.lastLabel ?? null };
        }),
      },
    });
    return { status: "done", slot: slot.id, nav: perf.nav, reason: note };
  } catch (err) {
    console.error("[sim-portfolio] 執行失敗：", err);
    return { status: "failed", reason: err instanceof Error ? err.message : String(err), slot: slot.id };
  } finally {
    await releaseSimLock();
  }
}
