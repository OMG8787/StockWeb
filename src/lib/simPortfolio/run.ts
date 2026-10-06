import { getChart, getIndices, getQuote, getQuotesBatch } from "@/lib/data";
import type { Candle } from "@/lib/data/types";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { getActionBrief } from "@/lib/ai/actionBrief";
import { getStockRating, type StockRatingResult } from "@/lib/ai/stockRating";
import { describeRatingForHolding } from "@/lib/ai/holdingRating";
import { computeHoldingStop } from "@/lib/ai/holdingStop";
import {
  applySimOrder,
  computePerformance,
  currentSimSlot,
  markSlotDone,
  newSimState,
  planSimOrders,
  SIM_BENCHMARK_ETF,
  SIM_MAX_REVIEWS,
  slotDoneKey,
  upsertNavPoint,
  type BuyCandidate,
  type HeldReview,
  type SimSlotDef,
} from "./rules";
import { acquireSimLock, readSimState, releaseSimLock, simStoreEnabled, writeSimState } from "./store";
import { writeSimReview } from "./review";
import type { SimSlotId, SimState } from "./types";

/**
 * AI 模擬投資組合的執行（有 I/O）。由 /api/cron/warm-cache（cron-job.org 每 5 分鐘）順帶呼叫，
 * 不在執行時點時零 Redis 指令直接略過；也可手動打 /api/cron/sim-portfolio。
 * 買賣規則全在 rules.ts（純函式）；這裡只負責抓評等／報價、套用、存檔。
 */

export interface SimRunResult {
  status: "done" | "skipped" | "disabled" | "failed";
  reason?: string;
  slot?: SimSlotId;
  trades?: number;
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
  const held = describeRatingForHolding({ name: rated.name, symbol: h.symbol, price: p, rating: rated.rating }, { costBasis: h.avgCost, market: "TW" }, sinceBuy);
  const stop = computeHoldingStop({ candles, price: p, costBasis: h.avgCost, market: "TW" });
  return { review: { symbol: h.symbol, price: p, changePercent, rating: held.rating, newStop: stop?.price ?? null }, rated };
}

export async function runSimPortfolio(opts: { now?: Date; slot?: SimSlotDef | null } = {}): Promise<SimRunResult> {
  if (!simStoreEnabled) return { status: "disabled", reason: "沒有 Redis" };
  const now = opts.now ?? new Date();
  const slot = opts.slot ?? currentSimSlot(now);
  if (!slot) return { status: "skipped", reason: "不在執行時點（09:30、13:00、13:35 起）" };
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
    const [etfQuote, indices] = await Promise.all([getQuote(SIM_BENCHMARK_ETF, "TW").catch(() => null), getIndices().catch(() => [])]);
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
    if (!state) state = newSimState(now, { etf: etfQuote.price, index });

    // 買進候選＝今日建議名單（程式依本站綜合評等選出、已有凍結時段穩定機制），只取台股、評等即時重讀。
    const brief = await getActionBrief().catch(() => null);
    const pickSymbols = (brief?.picks ?? []).filter((p) => p.code === "buy").map((p) => p.symbol.toUpperCase());
    const heldSymbols = state.holdings.map((h) => h.symbol);
    const symbols = [...new Set([...heldSymbols, ...pickSymbols])];
    const quotes = await getQuotesBatch(symbols.map((symbol) => ({ market: "TW" as const, symbol }))).catch(() => symbols.map(() => null));
    const quoteOf = new Map(symbols.map((s, i) => [s, quotes[i]]));

    const held: HeldReview[] = [];
    for (const h of state.holdings) {
      const q = quoteOf.get(h.symbol);
      const r = await reviewHolding(h, q?.price ?? 0, q?.changePercent ?? 0);
      if (r) {
        held.push(r.review);
        h.lastLabel = r.review.rating.holdingLabel;
      }
    }
    const candidates: BuyCandidate[] = [];
    for (const sym of pickSymbols) {
      if (heldSymbols.includes(sym)) continue;
      const rated = await getStockRating(sym, undefined, "sim-portfolio").catch(() => null);
      if (!rated || rated.market !== "TW") continue;
      const q = quoteOf.get(sym);
      candidates.push({ symbol: sym, name: rated.name, price: q?.price && q.price > 0 ? q.price : rated.price, changePercent: q?.changePercent ?? 0, rating: rated.rating });
    }

    const prices = new Map<string, number>();
    for (const r of held) prices.set(r.symbol, r.price);
    for (const c of candidates) prices.set(c.symbol, c.price);
    const orders = planSimOrders({ state, day, held, candidates, prices });
    const at = now.toISOString();
    let executed = 0;
    for (const o of orders) if (applySimOrder(state, o, { at, day, slot: slot.id, index })) executed++;

    // 存這次的持有中出場價（下一個時點比對）；新買進的也算一次。
    const stopBySymbol = new Map(held.map((r) => [r.symbol, r.newStop]));
    for (const h of state.holdings) {
      if (prices.has(h.symbol)) h.lastPrice = prices.get(h.symbol);
      if (stopBySymbol.has(h.symbol)) h.stopPrice = stopBySymbol.get(h.symbol) ?? null;
      else {
        const candles = await dailyCandles(h.symbol);
        h.stopPrice = computeHoldingStop({ candles, price: prices.get(h.symbol) ?? h.avgCost, costBasis: h.avgCost, market: "TW" })?.price ?? null;
        h.lastLabel = candidates.find((c) => c.symbol === h.symbol)?.rating.holdingLabel ?? h.lastLabel;
      }
    }

    const perf = computePerformance(state, { prices, etf: etfQuote.price, index }, day);
    upsertNavPoint(state, { day, nav: perf.nav, cash: state.cash, etf: etfQuote.price, index });
    markSlotDone(state, day, slot.id);
    state.lastRun = {
      at,
      slot: slot.id,
      day,
      note: `${slot.label}：檢視持股 ${held.length} 檔、候選 ${candidates.length} 檔，成交 ${executed} 筆${brief ? "" : "（今日建議名單暫時抓不到，只檢視持股）"}`,
    };
    if (slot.id === "1335") {
      const review = await writeSimReview(state, perf, prices, day, now);
      state.reviews = [review, ...state.reviews.filter((r) => r.day !== day)].slice(0, SIM_MAX_REVIEWS);
    }
    await writeSimState(state);
    doneMemo.add(doneKey);
    return { status: "done", slot: slot.id, trades: executed, nav: perf.nav, reason: state.lastRun.note };
  } catch (err) {
    console.error("[sim-portfolio] 執行失敗：", err);
    return { status: "failed", reason: err instanceof Error ? err.message : String(err), slot: slot.id };
  } finally {
    await releaseSimLock();
  }
}
