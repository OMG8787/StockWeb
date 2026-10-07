import { detectMarket, getChart, getEarnings, getFundamentals, getIndices, getQuote, normalizeSymbol, searchStocks } from "@/lib/data";
import { getTwChipsHistory, type TwChipsDay } from "@/lib/data/chipsHistory";
import { ensureTwUniverseWarm, findInUniverse } from "@/lib/data/universe";
import { getStockRating } from "@/lib/ai/stockRating";
import { taipeiNow } from "@/lib/auth/accounts";
import { getStore } from "@/lib/auth/store";
import { INDICATOR_TYPE_MAP, type EvalContext, type IndicatorNeed } from "./indicatorCatalog";
import {
  applyBuy,
  applySell,
  evaluateStrategy,
  runSimDay,
  simEquity,
  SimTradeError,
  type Candidate,
  type SimState,
  type StrategyConfig,
  type UserIndicator,
} from "./engine";
import { listIndicators, listStrategies, persistSimResult, StrategyError, strategyIndicatorIds, type SimView } from "./store";

/**
 * 模擬倉的 I/O：準備判斷所需的資料（日K、法人、基本面、月營收、本站評等）、執行策略、寫回試算表。
 * 交易價一律用「當天收盤價」，所以自動交易排在收盤、法人資料公布後（vercel.json 的 cron）執行。
 */

const CANDLE_RANGE = "1y" as const;
// 跟網站其他批次抓日K的地方一樣保守：每檔本身就會並行抓多個月份，檔數再並行太多會被證交所限流
const CONCURRENCY = 2;
const CHIPS_DAYS = 20;
/** 一次執行最多花多少時間抓資料（Vercel 上限 300 秒，要留時間判斷與寫回試算表） */
const FETCH_BUDGET_MS = 200_000;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export interface Target {
  symbol: string;
  market: "TW" | "US";
  name: string;
}

/** 一次執行內共用的資料快取（排程一次跑很多模擬倉時，同一檔股票只抓一次） */
export class DataCache {
  private ctx = new Map<string, Promise<EvalContext | null>>();
  constructor(private needs: Set<IndicatorNeed>) {}

  addNeeds(needs: Iterable<IndicatorNeed>) {
    for (const n of needs) this.needs.add(n);
  }

  get(t: Target): Promise<EvalContext | null> {
    const key = `${t.market}:${t.symbol}:${[...this.needs].sort().join(",")}`;
    let p = this.ctx.get(key);
    if (!p) {
      p = buildContext(t, this.needs).catch(() => null);
      this.ctx.set(key, p);
    }
    return p;
  }
}

async function buildContext(t: Target, needs: Set<IndicatorNeed>): Promise<EvalContext | null> {
  const chart = await getChart(t.symbol, CANDLE_RANGE, t.market);
  const candles = (chart?.candles ?? []).filter((c) => !c.live);
  if (candles.length === 0) return null;
  const ctx: EvalContext = { symbol: t.symbol, market: t.market, candles };
  const jobs: Promise<unknown>[] = [];
  if (needs.has("fundamentals")) jobs.push(getFundamentals(t.symbol, t.market).then((f) => (ctx.fundamentals = f)).catch(() => null));
  if (needs.has("earnings")) jobs.push(getEarnings(t.symbol, t.market).then((e) => (ctx.earnings = e)).catch(() => null));
  if (needs.has("rating")) jobs.push(getStockRating(t.symbol, t.market).then((r) => (ctx.ratingCode = r?.rating.code ?? null)).catch(() => null));
  if (needs.has("chips") && t.market === "TW") {
    jobs.push(
      (async () => {
        await ensureTwUniverseWarm();
        const ex = findInUniverse(t.symbol, "TW")?.exchange;
        if (ex !== "TWSE" && ex !== "TPEx") return;
        const dates = candles.slice(-CHIPS_DAYS).map((c) => c.time);
        ctx.chipsDays = (await getTwChipsHistory(t.symbol, ex === "TPEx" ? "TPEX" : "TWSE", dates, 20_000)) as TwChipsDay[];
      })().catch(() => null),
    );
  }
  await Promise.all(jobs);
  return ctx;
}

function needsOf(cfg: StrategyConfig, indicators: UserIndicator[]): Set<IndicatorNeed> {
  const ids = new Set(strategyIndicatorIds(cfg));
  const out = new Set<IndicatorNeed>(["candles"]);
  for (const i of indicators) if (ids.has(i.id)) INDICATOR_TYPE_MAP.get(i.typeId)?.needs.forEach((n) => out.add(n));
  return out;
}

/** 全市場模式：台股成交量前 N 名（排除權證等沒有日K的會在抓資料時自然略過） */
async function marketTopTargets(n: number): Promise<Target[]> {
  const items = await searchStocks({ market: "TW", sortBy: "volume", sortDir: "desc" });
  return items.slice(0, n).map((i) => ({ symbol: i.symbol, market: "TW" as const, name: i.name }));
}

export function taipeiToday(): string {
  return taipeiNow().slice(0, 10);
}

async function taiexClose(): Promise<number | null> {
  const idx = await getIndices().catch(() => []);
  return idx.find((i) => i.symbol === "TAIEX")?.price ?? null;
}

export interface RunResult {
  simId: string;
  ran: boolean;
  note: string;
  trades: number;
}

/**
 * 依策略跑一次模擬倉，以「最新一個有收盤資料的交易日」為準（平日 16:40 排程＝當天；
 * 晚上或假日手動執行＝最近一個交易日）。同一個交易日只會執行一次，不會重複交易。
 */
export async function runSim(sim: SimView, opts: { cache?: DataCache; deadline?: number } = {}): Promise<RunResult> {
  const today = taipeiToday();
  const deadline = opts.deadline ?? Date.now() + FETCH_BUDGET_MS;
  const [strategies, indicators] = await Promise.all([listStrategies(sim.userId), listIndicators(sim.userId)]);
  const strategy = strategies.find((s) => s.id === sim.strategyId);
  if (!strategy) throw new StrategyError("模擬倉沒有設定策略，或策略已被刪除");

  const cfg = strategy.config;
  const cache = opts.cache ?? new DataCache(new Set());
  cache.addNeeds(needsOf(cfg, indicators));

  const universe = sim.universe === "market" ? await marketTopTargets(sim.marketTopN) : sim.symbols;
  const heldTargets: Target[] = sim.positions.map((p) => ({ symbol: p.symbol, market: p.market, name: p.name }));
  const all = new Map<string, Target>();
  for (const t of [...heldTargets, ...universe]) all.set(`${t.market}:${t.symbol}`, t);

  // 持股優先抓（要判斷停損停利）；時間到就不再抓新的，用已經抓到的判斷
  let skipped = 0;
  const contexts = await mapLimit([...all.values()], CONCURRENCY, async (t) => {
    if (Date.now() > deadline) {
      skipped++;
      return { t, ctx: null };
    }
    return { t, ctx: await cache.get(t) };
  });
  // 以多數股票的最後一根日K日期判斷「今天的收盤資料出來了沒」
  const lastDays = contexts.map((c) => c.ctx?.candles[c.ctx.candles.length - 1]?.time).filter((x): x is string => !!x);
  if (lastDays.length === 0) return finish(sim, "抓不到任何股票的日K，這次不交易", today, false);
  const day = lastDays.sort().at(-1)!;
  if (sim.lastRunDay >= day) return { simId: sim.id, ran: false, note: `最新交易日 ${day} 已經執行過，等下一個交易日收盤後再執行`, trades: 0 };

  const decisions = new Map<string, Candidate>();
  for (const { t, ctx } of contexts) {
    if (!ctx) continue;
    const lastCandle = ctx.candles[ctx.candles.length - 1];
    if (lastCandle.time !== day) continue; // 這檔今天沒有成交（停牌等）
    decisions.set(`${t.market}:${t.symbol}`, {
      symbol: t.symbol, market: t.market, name: t.name, price: lastCandle.close, decision: evaluateStrategy(cfg, indicators, ctx),
    });
  }
  const held = new Map([...decisions].filter(([k]) => sim.positions.some((p) => `${p.market}:${p.symbol}` === k)));
  const candidates = universe.map((t) => decisions.get(`${t.market}:${t.symbol}`)).filter((c): c is Candidate => !!c);

  const state: SimState = { initialCash: sim.initialCash, cash: sim.cash, positions: sim.positions };
  const result = runSimDay(state, cfg, day, held, candidates);
  const prices = new Map([...decisions].map(([k, c]) => [k, c.price]));
  const equity = simEquity(result.state, prices);
  const buys = result.trades.filter((t) => t.side === "buy").length;
  const sells = result.trades.length - buys;
  const missing = universe.length - candidates.length;
  const note =
    `${day} 收盤：掃描 ${candidates.length} 檔，${result.trades.length ? `買進 ${buys} 筆、賣出 ${sells} 筆` : "沒有符合條件的交易"}` +
    (missing > 0 ? `（${missing} 檔資料沒抓到${skipped ? "，時間不夠先略過" : ""}）` : "");
  await persistSimResult(
    sim,
    { cash: result.state.cash, positions: result.state.positions, equity },
    result.trades.map((t) => ({ ...t, day, pnl: t.pnl ?? null })),
    { day, runNote: note, markRun: true, indexClose: await taiexClose() },
  );
  return { simId: sim.id, ran: true, note, trades: result.trades.length };
}

/** 沒有交易：只記下這次沒交易的原因（不改 LastRunDay，資料出來後的下一次排程還會再跑） */
async function finish(sim: SimView, note: string, day: string, ran: boolean): Promise<RunResult> {
  await getStore().batch([{ op: "update", table: "Sims", key: sim.id, patch: { LastRunNote: `${day}：${note}` } }]).catch(() => {});
  return { simId: sim.id, ran, note, trades: 0 };
}

/** 手動下單：以最新報價（盤中為即時價）成交。 */
export async function manualTrade(
  sim: SimView,
  o: { side: "buy" | "sell"; symbol: string; market?: "TW" | "US"; shares: number },
): Promise<{ price: number; fee: number; pnl?: number; priceNote: string }> {
  const quote = await resolveTradePrice(o.symbol, o.market);
  const market = quote.market;
  const day = taipeiToday();
  const state: SimState = { initialCash: sim.initialCash, cash: sim.cash, positions: sim.positions };
  let r;
  try {
    r =
      o.side === "buy"
        ? applyBuy(state, { symbol: quote.symbol, market, name: quote.name, shares: o.shares, price: quote.price, day, reason: "手動下單", source: "manual" })
        : applySell(state, { symbol: quote.symbol, market, shares: o.shares, price: quote.price, reason: "手動下單", source: "manual" });
  } catch (err) {
    if (err instanceof SimTradeError) throw new StrategyError(err.message);
    throw err;
  }
  const prices = new Map([[`${market}:${quote.symbol}`, quote.price]]);
  await persistSimResult(sim, { cash: r.state.cash, positions: r.state.positions, equity: simEquity(r.state, prices) }, [{ ...r.trade, day, pnl: r.trade.pnl ?? null }], { day });
  return { price: quote.price, fee: r.trade.fee, pnl: r.trade.pnl, priceNote: quote.note };
}

/** 手動下單的成交價：先用即時報價；報價來源暫時不通時退回最近一個交易日的收盤價（並註明）。 */
async function resolveTradePrice(
  symbolRaw: string,
  marketHint?: "TW" | "US",
): Promise<{ symbol: string; market: "TW" | "US"; name: string; price: number; note: string }> {
  const quote = await getQuote(symbolRaw, marketHint).catch(() => null);
  if (quote && quote.price > 0) {
    return { symbol: quote.symbol, market: quote.market === "US" ? "US" : "TW", name: quote.name, price: quote.price, note: "最新報價" };
  }
  const symbol = normalizeSymbol(symbolRaw);
  const market = marketHint ?? (detectMarket(symbol) === "US" ? "US" : "TW");
  const chart = await getChart(symbol, "1m", market).catch(() => null);
  const last = chart?.candles.filter((c) => !c.live).at(-1);
  if (!last) throw new StrategyError("抓不到這檔股票的報價（代號不存在，或資料來源暫時忙碌）");
  if (market === "TW") await ensureTwUniverseWarm().catch(() => {});
  const name = (market === "TW" ? findInUniverse(symbol, "TW")?.name : undefined) ?? symbol;
  return { symbol, market, name, price: last.close, note: `即時報價暫時抓不到，以 ${last.time} 收盤價成交` };
}

/** 試算：用策略判斷單一股票（策略頁的「測試一檔」）。 */
export async function previewStrategy(userId: string, strategyId: string, target: { symbol: string; market?: "TW" | "US" }) {
  const [strategies, indicators] = await Promise.all([listStrategies(userId), listIndicators(userId)]);
  const strategy = strategies.find((s) => s.id === strategyId);
  if (!strategy) throw new StrategyError("找不到這個策略", 404);
  // 只需要日K：股名從股票清單查，不依賴即時報價（報價伺服器限流時也能測）
  const symbol = normalizeSymbol(target.symbol);
  if (!symbol) throw new StrategyError("請輸入股票代號");
  const market = target.market ?? (detectMarket(symbol) === "US" ? "US" : "TW");
  if (market === "TW") await ensureTwUniverseWarm().catch(() => {});
  const t: Target = { symbol, market, name: (market === "TW" ? findInUniverse(symbol, "TW")?.name : undefined) ?? symbol };
  const ctx = await new DataCache(needsOf(strategy.config, indicators)).get(t);
  if (!ctx) throw new StrategyError(`抓不到 ${symbol} 的日K（代號不存在，或資料來源暫時忙碌，請稍後再試）`);
  return { symbol: t.symbol, name: t.name, lastDay: ctx.candles.at(-1)?.time ?? "", decision: evaluateStrategy(strategy.config, indicators, ctx) };
}
