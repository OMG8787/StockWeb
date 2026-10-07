import { getIndices, getQuote, getQuotesBatch } from "@/lib/data";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import {
  computePerformance,
  SIM_ADD_POSITION_PCT,
  SIM_BENCHMARK_ETF,
  SIM_LEVERAGED_ETF,
  SIM_INITIAL_CAPITAL,
  SIM_FIXED_FILL_TIME,
  SIM_LIMIT_LOCK_PCT,
  SIM_MAX_VOLUME_SHARE,
  SIM_MAX_POSITION_PCT,
  SIM_MAX_POSITIONS,
  SIM_MIN_TRADE_AMOUNT,
  SIM_NEW_POSITION_PCT,
  SIM_SLOTS,
  sellFee,
  type SimPerformance,
} from "./rules";
import { readSimStateCached, simStoreEnabled } from "./store";
import type { SimBase, SimNavPoint, SimPendingOrder, SimReview, SimTrade } from "./types";
import { TW_BUY_COMMISSION_RATE, TW_SELL_COMMISSION_RATE, TW_SELL_TAX_RATE } from "@/lib/tradingCosts";

/** /api/sim-portfolio 的回應（首頁卡片與 /portfolio 頁共用）。 */
export interface SimHoldingView {
  symbol: string;
  name: string;
  shares: number;
  avgCost: number;
  price: number;
  changePercent: number | null;
  marketValue: number;
  /** 未實現損益（已扣假設賣出成本） */
  pnl: number;
  pnlPct: number;
  /** 占淨值比例（%） */
  weightPct: number;
  buyDay: string;
  stopPrice: number | null;
  label: string | null;
}

export interface SimPortfolioView {
  enabled: boolean;
  started: boolean;
  startDay?: string;
  initialCapital: number;
  cash?: number;
  /** 對照組起點（0050 價格、加權指數、00631L 價格與起算日） */
  base?: SimBase;
  perf?: SimPerformance;
  holdings?: SimHoldingView[];
  trades?: SimTrade[];
  /** 盤後定價委託中（14:30 以收盤價成交） */
  pending?: SimPendingOrder[];
  nav?: SimNavPoint[];
  reviews?: SimReview[];
  lastRun?: { at: string; slot: string; day: string; note: string };
  /** 規則常數（頁面誠實標示用，跟 rules.ts 同一份） */
  rules: {
    maxPositions: number;
    newPositionPct: number;
    maxPositionPct: number;
    addPositionPct: number;
    minTradeAmount: number;
    limitLockPct: number;
    maxVolumeSharePct: number;
    fixedFillTime: string;
    buyFeeRate: number;
    sellFeeRate: number;
    sellTaxRate: number;
    benchmark: string;
    /** 第二個對照：00631L（2 倍槓桿 ETF） */
    leveragedBenchmark: string;
    slots: Array<{ label: string; fill: string }>;
  };
  asOf: string;
}

/** 比例 → 百分比（去掉浮點尾數，例如 0.001425 → 0.1425）。 */
const asPct = (rate: number) => Math.round(rate * 100 * 1e6) / 1e6;

const RULES: SimPortfolioView["rules"] = {
  maxPositions: SIM_MAX_POSITIONS,
  newPositionPct: SIM_NEW_POSITION_PCT * 100,
  maxPositionPct: SIM_MAX_POSITION_PCT * 100,
  addPositionPct: SIM_ADD_POSITION_PCT * 100,
  minTradeAmount: SIM_MIN_TRADE_AMOUNT,
  limitLockPct: SIM_LIMIT_LOCK_PCT,
  maxVolumeSharePct: SIM_MAX_VOLUME_SHARE * 100,
  fixedFillTime: SIM_FIXED_FILL_TIME,
  buyFeeRate: asPct(TW_BUY_COMMISSION_RATE),
  sellFeeRate: asPct(TW_SELL_COMMISSION_RATE),
  sellTaxRate: asPct(TW_SELL_TAX_RATE),
  benchmark: SIM_BENCHMARK_ETF,
  leveragedBenchmark: SIM_LEVERAGED_ETF,
  slots: SIM_SLOTS.map((s) => ({ label: s.label, fill: s.fill })),
};

/** 讀狀態＋即時報價算出現在的淨值與損益（報價走既有快取；Redis 讀取每個執行個體 60 秒快取一次）。 */
export async function getSimPortfolioView(opts: { tradeLimit?: number } = {}): Promise<SimPortfolioView> {
  const asOf = new Date().toISOString();
  if (!simStoreEnabled) return { enabled: false, started: false, initialCapital: SIM_INITIAL_CAPITAL, rules: RULES, asOf };
  const state = await readSimStateCached();
  if (!state) return { enabled: true, started: false, initialCapital: SIM_INITIAL_CAPITAL, rules: RULES, asOf };
  const symbols = [...state.holdings.map((h) => h.symbol), SIM_BENCHMARK_ETF, SIM_LEVERAGED_ETF];
  const [quotes, indices] = await Promise.all([
    getQuotesBatch(symbols.map((symbol) => ({ market: "TW" as const, symbol }))).catch(() => symbols.map(() => null)),
    getIndices().catch(() => []),
  ]);
  // 批次報價對個別股票可能回 null（全市場表缺那一檔）：改用單檔報價補，再不行才用上次執行的價格（不用成本價頂替）。
  await Promise.all(
    symbols.map(async (s, i) => {
      if (!quotes[i] || !(quotes[i]!.price > 0)) quotes[i] = await getQuote(s, "TW").catch(() => null);
    })
  );
  const prices = new Map<string, number>();
  const changes = new Map<string, number>();
  for (const h of state.holdings) if (h.lastPrice && h.lastPrice > 0) prices.set(h.symbol, h.lastPrice);
  symbols.forEach((s, i) => {
    const q = quotes[i];
    if (q && q.price > 0) {
      prices.set(s, q.price);
      changes.set(s, q.changePercent);
    }
  });
  const lastNav = state.nav[state.nav.length - 1];
  const etf = prices.get(SIM_BENCHMARK_ETF) ?? lastNav?.etf ?? null;
  const lev = prices.get(SIM_LEVERAGED_ETF) ?? lastNav?.lev ?? null;
  const index = indices.find((i) => i.symbol === "TAIEX")?.price ?? lastNav?.index ?? null;
  const perf = computePerformance(state, { prices: prices, etf, index, lev }, taipeiDayKey());
  const holdings: SimHoldingView[] = state.holdings.map((h) => {
    const price = prices.get(h.symbol) ?? h.avgCost;
    const marketValue = Math.round(price * h.shares);
    const pnl = marketValue - sellFee(price, h.shares) - h.invested;
    return {
      symbol: h.symbol,
      name: h.name,
      shares: h.shares,
      avgCost: h.avgCost,
      price,
      changePercent: changes.get(h.symbol) ?? null,
      marketValue,
      pnl,
      pnlPct: h.invested > 0 ? Math.round((pnl / h.invested) * 10000) / 100 : 0,
      weightPct: perf.nav > 0 ? Math.round((marketValue / perf.nav) * 1000) / 10 : 0,
      buyDay: h.buyDay,
      stopPrice: h.stopPrice,
      label: h.lastLabel ?? null,
    };
  });
  holdings.sort((a, b) => b.marketValue - a.marketValue);
  return {
    enabled: true,
    started: true,
    startDay: state.startDay,
    initialCapital: state.initialCapital,
    cash: state.cash,
    base: state.base,
    perf,
    holdings,
    trades: state.trades.slice(0, opts.tradeLimit ?? state.trades.length),
    pending: (state.pending ?? []).filter((p) => p.day === taipeiDayKey()),
    nav: state.nav,
    reviews: state.reviews,
    lastRun: state.lastRun,
    rules: RULES,
    asOf,
  };
}
