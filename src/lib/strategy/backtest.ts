import type { Candle } from "@/lib/data/types";
import { INDICATOR_TYPE_MAP } from "./indicatorCatalog";
import { evaluateStrategy, runSimDay, type Candidate, type SimState, type SimTradeInput, type StrategyConfig, type UserIndicator } from "./engine";

/**
 * 策略回測（2026-10-15 使用者：「開一個模擬，用策略回顧之前的功能，看能回顧多少，拉到 1-3 年前查看是否照策略會賺」）。純計算、有測試。
 *
 * 做法（不偷看未來）：
 *  - 第 t 天收盤後，只用「截到第 t 天」的日K判斷每一檔（跟模擬倉同一個 evaluateStrategy、同一套風控 runSimDay）；
 *  - 訂單在下一個交易日（t+1）以開盤價成交，手續費與證交稅照實扣；
 *  - 每天以收盤價計算淨值；對照組＝同期第一天開盤買進 0050 持有到最後（只計價格、不含股息）。
 * 限制（畫面要寫清楚）：籌碼、基本面、月營收、本站綜合評等、即時五檔沒有逐日歷史，回測時這些條件一律「資料不足」（不成立）；
 * 股票名單是使用者現在選的（倖存者偏差：已下市的股票不在裡面）。
 */

export interface BacktestSeries {
  symbol: string;
  market: "TW" | "US";
  name: string;
  /** 舊到新的日K（要含開始日之前的暖機資料） */
  candles: Candle[];
}

export interface BacktestTrade extends SimTradeInput {
  day: string;
}

export interface BacktestResult {
  start: string;
  end: string;
  tradingDays: number;
  initialCash: number;
  finalEquity: number;
  totalReturnPct: number;
  /** 年化報酬 % */
  cagrPct: number;
  maxDrawdownPct: number;
  benchReturnPct: number | null;
  /** 每個交易日的淨值與 0050 對照（都是相對起點的報酬 %） */
  curve: Array<{ day: string; pct: number; bench: number | null }>;
  trades: BacktestTrade[];
  stats: { buys: number; sells: number; wins: number; winRate: number | null; avgHoldDays: number | null; fees: number; realized: number };
  perStock: Array<{ symbol: string; name: string; sells: number; realized: number }>;
  /** 期末還持有的部位（以最後收盤計） */
  openPositions: Array<{ symbol: string; name: string; shares: number; avgCost: number; lastClose: number; pnlPct: number; buyDay: string }>;
  /** 這個策略裡沒有逐日歷史、回測時當成「資料不足」的參考指標名稱 */
  unsupported: string[];
  /** 抓不到或資料太短被略過的股票 */
  skipped: string[];
}

/** 這個策略用到、但沒有逐日歷史的參考指標（籌碼、基本面、月營收、本站評等、即時五檔） */
export function unsupportedIndicators(cfg: StrategyConfig, indicators: UserIndicator[]): string[] {
  const ids = new Set(cfg.mode === "score" ? Object.keys(cfg.weights) : [...cfg.buy.ids, ...cfg.sell.ids]);
  return indicators
    .filter((i) => ids.has(i.id))
    .filter((i) => (INDICATOR_TYPE_MAP.get(i.typeId)?.needs ?? []).some((n) => n !== "candles"))
    .map((i) => i.name);
}

function maxDrawdown(values: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) mdd = Math.min(mdd, (v / peak - 1) * 100);
  }
  return mdd;
}

export function runBacktest(input: {
  cfg: StrategyConfig;
  indicators: UserIndicator[];
  series: BacktestSeries[];
  bench: Candle[] | null;
  startDay: string;
  initialCash: number;
}): BacktestResult {
  const { cfg, indicators, initialCash } = input;
  // 至少要有開始日之前 30 根（指標暖機）與開始日之後 2 根，才拿來回測
  const usable = input.series.filter((s) => s.candles.filter((c) => c.time < input.startDay).length >= 30 && s.candles.filter((c) => c.time >= input.startDay).length >= 2);
  const skipped = input.series.filter((s) => !usable.includes(s)).map((s) => s.symbol);
  const index = usable.map((s) => new Map(s.candles.map((c, i) => [c.time, i])));
  const calSource = input.bench && input.bench.length ? input.bench.map((c) => c.time) : [...new Set(usable.flatMap((s) => s.candles.map((c) => c.time)))].sort();
  const calendar = calSource.filter((d) => d >= input.startDay);

  let state: SimState = { initialCash, cash: initialCash, positions: [] };
  const trades: BacktestTrade[] = [];
  const lastClose = new Map<string, number>();
  const curveEq: Array<{ day: string; equity: number }> = [];
  const benchIdx = input.bench ? new Map(input.bench.map((c, i) => [c.time, i])) : null;
  const benchStartOpen = input.bench && calendar.length ? input.bench[benchIdx!.get(calendar[0]) ?? -1]?.open ?? null : null;
  const holdDays: number[] = [];

  for (let t = 0; t < calendar.length; t++) {
    const day = calendar[t];
    // ① 用前一個交易日（含）以前的日K判斷，今天開盤成交
    if (t > 0) {
      const prevDay = calendar[t - 1];
      const decisions = new Map<string, Candidate>();
      usable.forEach((s, k) => {
        const pi = index[k].get(prevDay);
        const ti = index[k].get(day);
        if (pi == null || ti == null) return; // 前一天或今天沒交易（停牌）就不動
        const decision = evaluateStrategy(cfg, indicators, { symbol: s.symbol, market: s.market, candles: s.candles.slice(0, pi + 1) });
        decisions.set(`${s.market}:${s.symbol}`, { symbol: s.symbol, market: s.market, name: s.name, price: s.candles[ti].open, decision });
      });
      const held = new Map([...decisions].filter(([key]) => state.positions.some((p) => `${p.market}:${p.symbol}` === key)));
      const before = new Map(state.positions.map((p) => [`${p.market}:${p.symbol}`, p.buyDay]));
      const r = runSimDay(state, cfg, day, held, [...decisions.values()]);
      state = r.state;
      for (const tr of r.trades) {
        trades.push({ ...tr, day });
        if (tr.side === "sell") {
          const bd = before.get(`${tr.market}:${tr.symbol}`);
          if (bd) holdDays.push(calendar.indexOf(day) - calendar.indexOf(bd));
        }
      }
    }
    // ② 收盤計算淨值
    usable.forEach((s, k) => {
      const i = index[k].get(day);
      if (i != null) lastClose.set(`${s.market}:${s.symbol}`, s.candles[i].close);
    });
    const equity = state.cash + state.positions.reduce((a, p) => a + p.shares * (lastClose.get(`${p.market}:${p.symbol}`) ?? p.avgCost), 0);
    curveEq.push({ day, equity });
  }

  const sells = trades.filter((t) => t.side === "sell");
  const wins = sells.filter((t) => (t.pnl ?? 0) > 0).length;
  const finalEquity = curveEq.length ? curveEq[curveEq.length - 1].equity : initialCash;
  const totalReturnPct = (finalEquity / initialCash - 1) * 100;
  const start = calendar[0] ?? input.startDay;
  const end = calendar[calendar.length - 1] ?? input.startDay;
  const years = Math.max(1 / 365, (Date.parse(end) - Date.parse(start)) / (365.25 * 86_400_000));
  const benchPct = (day: string) => {
    if (!input.bench || !benchStartOpen) return null;
    const i = benchIdx!.get(day);
    return i == null ? null : (input.bench[i].close / benchStartOpen - 1) * 100;
  };
  const per = new Map<string, { symbol: string; name: string; sells: number; realized: number }>();
  for (const t of sells) {
    const k = t.symbol;
    const cur = per.get(k) ?? { symbol: t.symbol, name: t.name, sells: 0, realized: 0 };
    cur.sells++;
    cur.realized += t.pnl ?? 0;
    per.set(k, cur);
  }
  return {
    start,
    end,
    tradingDays: calendar.length,
    initialCash,
    finalEquity,
    totalReturnPct,
    cagrPct: (Math.pow(Math.max(finalEquity, 0) / initialCash, 1 / years) - 1) * 100,
    maxDrawdownPct: maxDrawdown(curveEq.map((c) => c.equity)),
    benchReturnPct: benchPct(end),
    curve: curveEq.map((c) => ({ day: c.day, pct: (c.equity / initialCash - 1) * 100, bench: benchPct(c.day) })),
    trades,
    stats: {
      buys: trades.length - sells.length,
      sells: sells.length,
      wins,
      winRate: sells.length ? (wins / sells.length) * 100 : null,
      avgHoldDays: holdDays.length ? holdDays.reduce((a, b) => a + b, 0) / holdDays.length : null,
      fees: trades.reduce((a, t) => a + t.fee, 0),
      realized: sells.reduce((a, t) => a + (t.pnl ?? 0), 0),
    },
    perStock: [...per.values()].sort((a, b) => b.realized - a.realized),
    openPositions: state.positions.map((p) => {
      const lc = lastClose.get(`${p.market}:${p.symbol}`) ?? p.avgCost;
      return { symbol: p.symbol, name: p.name, shares: p.shares, avgCost: p.avgCost, lastClose: lc, pnlPct: (lc / p.avgCost - 1) * 100, buyDay: p.buyDay };
    }),
    unsupported: unsupportedIndicators(cfg, indicators),
    skipped,
  };
}
