import { cached, cachedMap, mapWithConcurrency, peekCached, writeCached } from "./cache";
import type { Candle, ChartRange, ChartResponse, Chips, Earnings, Fundamentals, IndexQuote, Market, MaterialAnnouncement, Quote, SearchItem } from "./types";
import { US_UNIVERSE, findInUniverse, findSymbolByName, getTwUniverse, UniverseEntry } from "./universe";
import {
  fetchTwseCandles,
  fetchTwseFundamentalsAll,
  fetchTwseInstitutionalTradingAll,
  fetchTwseMarginTradingAll,
  fetchTwseMaterialAnnouncementsAll,
  fetchTwseMonthlyRevenueAll,
  fetchTwseQuarterlyEpsAll,
  fetchTwseQuote,
  fetchTwseQuotesBatch,
} from "./twse";
import {
  fetchTpexCandles,
  fetchTpexFundamentalsAll,
  fetchTpexInstitutionalTradingAll,
  fetchTpexMarginTradingAll,
  fetchTpexMaterialAnnouncementsAll,
  fetchTpexMonthlyRevenueAll,
  fetchTpexQuarterlyEpsAll,
  fetchTpexQuote,
  fetchTpexQuotesBatch,
} from "./tpex";
import { fetchUsCandles, fetchUsEarnings, fetchUsFundamentals, fetchUsQuote, fetchUsQuotesBatch, fetchYahooIntradayCandles } from "./us";
import { fetchYahooTwMarketDepth, type MarketDepth } from "./yahooTwMarketDepth";
import { fetchTaifexNightFutures } from "./taifex";
import type { TaifexFuturesQuote } from "./types";
import { computeIndicatorState, computeSignals, computeStreak, type IndicatorState, type Signal } from "@/lib/signals";
import { isTwQuoteWindow } from "@/lib/pollingSchedule";
import { backfillVolumeHistoryFromCandles, computeVolumeMetrics, getTrailingAverageVolumeMap, maybeRecordDailyVolumeSnapshot } from "./volumeHistory";
import type { VolumeTrend } from "./types";

export * from "./types";
export type { MarketDepth } from "./yahooTwMarketDepth";
export { sectorsFor, getTwUniverse, findSymbolByName, findAllSymbolsByName, findInUniverse, searchUniverseByQuery } from "./universe";
export type { UniverseEntry } from "./universe";
export { describeTaifexNightFutures } from "./taifex";

async function universeFor(market: Market): Promise<UniverseEntry[]> {
  return market === "TW" ? getTwUniverse() : US_UNIVERSE;
}

export function detectMarket(symbolInput: string): Market {
  const known = findInUniverse(symbolInput);
  if (known) return known.market;
  return /^\d{3,6}$/.test(symbolInput.trim()) ? "TW" : "US";
}

/**
 * Route params (e.g. the [symbol] segment in /stock/[symbol]) can arrive
 * still percent-encoded in some Next.js render paths — decode defensively
 * so a Chinese company name typed into the header search box (which just
 * navigates straight to /stock/<input>) doesn't show up as raw "%E5%8F..."
 * on the page. Safe to call on an already-decoded plain symbol like
 * "2330"/"AAPL" too: decodeURIComponent is a no-op without a "%" in it.
 */
export function normalizeSymbol(symbolInput: string): string {
  let decoded = symbolInput;
  try {
    decoded = decodeURIComponent(symbolInput);
  } catch {
    // malformed percent-encoding; fall back to the raw input
  }
  const trimmed = decoded.trim();
  // The header search box and "/stock/<input>" both accept a company name
  // typed in directly (e.g. "台積電"), not just a ticker — resolve that to
  // its actual code before the market-agnostic uppercase/suffix cleanup
  // below, which would otherwise pass the name straight through to a data
  // source that only understands codes/tickers and get "資料暫缺" back for
  // a perfectly findable stock.
  const byName = findSymbolByName(trimmed);
  if (byName) return byName.symbol;
  return trimmed.toUpperCase().replace(/\.(TW|TWO|US)$/i, "");
}

const QUOTE_TTL_MS = 20_000;
/**
 * 台股 08:30~14:30（股市運作期間）的報價快取 TTL。前端在這段時間改成每 1 分鐘
 * 輪詢一次（見 lib/pollingSchedule.ts，2026-09-20 從10秒調整成1分鐘），這裡跟著
 * 對齊成 60 秒——沒必要比前端輪詢間隔還短，快取命中率才會高，白白重抓的次數
 * 才會降到最低。這段時間以外前端根本不輪詢，所以沿用原本的 20 秒即可。
 */
const TW_LIVE_QUOTE_TTL_MS = 60_000;

/** 台股盤中 1 分鐘、其餘情況（含所有美股報價）維持原本的 20 秒。 */
function quoteTtlMs(market: Market): number {
  return market === "TW" && isTwQuoteWindow() ? TW_LIVE_QUOTE_TTL_MS : QUOTE_TTL_MS;
}
const CHART_TTL_MS = 5 * 60_000;
// The "today" intraday range updates roughly once a minute at the source
// (Yahoo's own 1-minute bars) — a 5-minute TTL would show the same stale
// snapshot for several new bars in a row, defeating the point of an
// intraday view. 60s keeps it genuinely near-live without re-fetching for
// every single poll of a chart a user might have open.
const INTRADAY_CHART_TTL_MS = 60_000;

/**
 * TW has two exchanges behind one public "TW" market — a given symbol must
 * be routed to the right one before a per-symbol (single-source) fetch can
 * happen at all. `findInUniverse` carries the answer whenever the symbol is
 * already known; for the rare case of a symbol not indexed yet (a very new
 * IPO, or simply a wrong/nonexistent code), TWSE is tried first (unchanged
 * default/common-case latency) and TPEx only as a second attempt — this
 * ambiguous-symbol path is rare enough that the extra latency it can incur
 * is an acceptable tradeoff, and it must never slow down the common case
 * where the exchange is already known.
 */
function resolveTwExchange(symbol: string): "TWSE" | "TPEx" | undefined {
  return findInUniverse(symbol, "TW")?.exchange;
}

async function fetchTwQuote(symbol: string): Promise<Quote> {
  const exchange = resolveTwExchange(symbol);
  if (exchange === "TPEx") return fetchTpexQuote(symbol);
  if (exchange === "TWSE") return fetchTwseQuote(symbol);
  try {
    return await fetchTwseQuote(symbol);
  } catch (err) {
    try {
      return await fetchTpexQuote(symbol);
    } catch {
      throw err;
    }
  }
}

async function fetchTwChart(symbol: string, range: ChartRange): Promise<Candle[]> {
  const exchange = resolveTwExchange(symbol);
  if (exchange === "TPEx") return fetchTpexCandles(symbol, range);
  if (exchange === "TWSE") return fetchTwseCandles(symbol, range);
  try {
    return await fetchTwseCandles(symbol, range);
  } catch (err) {
    try {
      return await fetchTpexCandles(symbol, range);
    } catch {
      throw err;
    }
  }
}

/**
 * Returns null (never a fabricated value) when the live source can't be
 * reached — stock data must be accurate, so an unavailable quote is shown
 * as unavailable rather than filled in with a guess.
 */
export async function getQuote(symbolInput: string, marketHint?: Market): Promise<Quote | null> {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  return cached(`quote:${market}:${symbol}`, quoteTtlMs(market), async () => {
    try {
      return market === "TW" ? await fetchTwQuote(symbol) : await fetchUsQuote(symbol);
    } catch {
      return null;
    }
  });
}

/**
 * TWSE/TPEx have no free public intraday-history API of their own (their
 * MIS real-time endpoint — used elsewhere for live quotes — only ever
 * returns the current snapshot, not a same-day series), so "today" is
 * routed through Yahoo for TW too, via the same ticker-suffix convention
 * Yahoo itself uses on its own site (`.TW` for TWSE, `.TWO` for TPEx) —
 * confirmed live that both work, and that guessing wrong 404s outright
 * (Yahoo does not fall back on its own).
 *
 * Tries the exchange resolveTwExchange() reports first, but always falls
 * back to the other suffix on failure rather than trusting that lookup
 * outright — confirmed live this matters: a cold serverless instance that
 * hasn't yet run getTwUniverse() (getChart() doesn't await it the way e.g.
 * ai/ask.ts's guessSymbolsFromText() explicitly does) sees an unresolved
 * exchange for a real TPEx symbol and guessed `.TW`, which 404s outright
 * for a code that only exists on TPEx (real repro: 6811/宏碁資訊). Same
 * try-the-likely-one-then-the-other resilience fetchTwQuote()/fetchTwChart()
 * already use for their own TWSE/TPEx split, just expressed as two Yahoo
 * suffixes instead of two different upstream hosts.
 */
async function fetchTwIntradayCandles(symbol: string): Promise<Candle[]> {
  const exchange = resolveTwExchange(symbol);
  const first = exchange === "TPEx" ? "TWO" : "TW";
  const second = first === "TW" ? "TWO" : "TW";
  try {
    return await fetchYahooIntradayCandles(`${symbol}.${first}`);
  } catch (err) {
    try {
      return await fetchYahooIntradayCandles(`${symbol}.${second}`);
    } catch {
      throw err;
    }
  }
}

/** Returns null when the live source can't be reached; never fabricated candles. */
export async function getChart(
  symbolInput: string,
  range: ChartRange,
  marketHint?: Market
): Promise<ChartResponse | null> {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  const ttl = range === "today" ? INTRADAY_CHART_TTL_MS : CHART_TTL_MS;
  return cached(`chart:${market}:${symbol}:${range}`, ttl, async () => {
    try {
      const candles =
        range === "today"
          ? market === "TW"
            ? await fetchTwIntradayCandles(symbol)
            : await fetchYahooIntradayCandles(symbol)
          : market === "TW"
            ? await fetchTwChart(symbol, range)
            : await fetchUsCandles(symbol, range);
      return { symbol, market, range, candles };
    } catch {
      return null;
    }
  });
}

/**
 * Merges a TWSE whole-market map with TPEx's equivalent for the same
 * category (fundamentals, monthly revenue, quarterly EPS, institutional
 * trading, margin trading, material announcements all follow this exact
 * shape) — no symbol-collision risk (see getTwUniverse's comment: TW codes
 * come from one shared national registry). Each side is wrapped in its own
 * catch so a TPEx endpoint outage never takes down TWSE data for that
 * category, or vice versa — same "degrade per source" pattern as
 * getIndices' per-index try/catch and getTwUniverse's per-exchange fetch.
 */
async function mergeTwMaps<V>(
  fetchTwse: () => Promise<Map<string, V>>,
  fetchTpex: () => Promise<Map<string, V>>
): Promise<Map<string, V>> {
  const [twse, tpex] = await Promise.all([
    fetchTwse().catch(() => new Map<string, V>()),
    fetchTpex().catch(() => new Map<string, V>()),
  ]);
  return new Map([...twse, ...tpex]);
}

// 2026-09-20：從 5 分鐘拉回 30 分鐘。這裡曾經從「1小時」改成「5分鐘」是為了
// 跟全站快報/建議/新聞那批 5 分鐘標準看齊，但本益比/股價淨值比/殖利率/市值這類
// 基本面數字本質上一天只會變一次（收盤價才會變動），5分鐘重算一次沒有換到任何
// 真正的新鮮度，只是讓 warm-cache 這支背景排程（每5分鐘觸發一次）白白多算很多次
// ——這是 Vercel 免費方案用量吃緊後盤點出來的真實浪費源頭之一，30分鐘仍然遠比
// 「一天只變一次」的實際更新頻率頻繁，使用者不會感覺到任何變舊。
const FUNDAMENTALS_TTL_MS = 30 * 60_000;

/**
 * Returns null when unavailable — fabricating a P/E ratio or dividend
 * yield next to a real price would be more misleading than just omitting it.
 */
export async function getFundamentals(symbolInput: string, marketHint?: Market): Promise<Fundamentals | null> {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  try {
    if (market === "TW") {
      const map = await cachedMap("fundamentals:TW:all", FUNDAMENTALS_TTL_MS, () =>
        mergeTwMaps(fetchTwseFundamentalsAll, fetchTpexFundamentalsAll)
      );
      return map.get(symbol) ?? null;
    }
    return await cached(`fundamentals:US:${symbol}`, FUNDAMENTALS_TTL_MS, () => fetchUsFundamentals(symbol));
  } catch {
    return null;
  }
}

// 2026-09-20：拉長到 1 小時——月營收一個月只公布一次、季報EPS一季只公布一次，
// 5分鐘重算完全是白工，理由同 FUNDAMENTALS_TTL_MS 的說明。
const EARNINGS_TTL_MS = 60 * 60_000;

/**
 * Returns null when unavailable — a bank/insurer isn't in TWSE's general
 * quarterly-EPS dataset (see fetchTwseQuarterlyEpsAll), and that's shown as
 * "no data" rather than silently misreporting a peer company's number.
 */
export async function getEarnings(symbolInput: string, marketHint?: Market): Promise<Earnings | null> {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  try {
    if (market === "TW") {
      const [revenueMap, epsMap] = await Promise.all([
        cachedMap("earnings:TW:revenue", EARNINGS_TTL_MS, () =>
          mergeTwMaps(fetchTwseMonthlyRevenueAll, fetchTpexMonthlyRevenueAll)
        ),
        cachedMap("earnings:TW:eps", EARNINGS_TTL_MS, () =>
          mergeTwMaps(fetchTwseQuarterlyEpsAll, fetchTpexQuarterlyEpsAll)
        ),
      ]);
      const revenue = revenueMap.get(symbol);
      const eps = epsMap.get(symbol);
      if (!revenue && !eps) return null;
      return { ...revenue, ...eps };
    }
    return await cached(`earnings:US:${symbol}`, EARNINGS_TTL_MS, () => fetchUsEarnings(symbol));
  } catch {
    return null;
  }
}

// 2026-09-20：拉長到 1 小時——三大法人買賣超/融資融券餘額是官方收盤後才公布
// 一次的報表，盤中/半夜每5分鐘重算是純浪費，理由同 FUNDAMENTALS_TTL_MS 的說明。
const CHIPS_TTL_MS = 60 * 60_000;

/**
 * TW only（籌碼面：三大法人買賣超＋融資融券餘額）— 美股沒有對應的公開資料
 * 源，一律回傳 null，不是抓取失敗。兩份資料都是「整個市場一次回傳」的報表，
 * 各自整包快取一次再依代號查表，不對每檔股票各打一次。
 */
export async function getChips(symbolInput: string, marketHint?: Market): Promise<Chips | null> {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  if (market !== "TW") return null;
  try {
    const [institutionalMap, marginMap] = await Promise.all([
      cachedMap("chips:TW:institutional", CHIPS_TTL_MS, () =>
        mergeTwMaps(fetchTwseInstitutionalTradingAll, fetchTpexInstitutionalTradingAll)
      ),
      cachedMap("chips:TW:margin", CHIPS_TTL_MS, () => mergeTwMaps(fetchTwseMarginTradingAll, fetchTpexMarginTradingAll)),
    ]);
    const institutional = institutionalMap.get(symbol);
    const margin = marginMap.get(symbol);
    if (!institutional && !margin) return null;
    return { ...institutional, ...margin };
  } catch {
    return null;
  }
}

// A single call here is a full ~370KB HTML page fetch (see
// yahooTwMarketDepth.ts) — genuinely heavier than a normal quote request, so
// this gets a longer TTL than QUOTE_TTL_MS's 20s to avoid re-paying that
// cost on every quick re-render of a stock page someone is actively
// watching. 60s still means "內外盤" catches up within a minute of a real
// swing in buy/sell-side pressure, which is what this figure is for.
const MARKET_DEPTH_TTL_MS = 60_000;

/**
 * TW only（內外盤）— 見 yahooTwMarketDepth.ts 的完整說明：這份資料只有
 * Yahoo 台灣在地化網頁有，且只能整頁抓取，所以只適合這種「使用者正在看
 * 這一檔股票」的單次查詢，故意沒有比照 getChips() 做成「整個市場一次回傳
 * 再查表」的批次模式（那份資料源本身就不支援批次查詢）。抓不到時回傳
 * null，不是抓取失敗就丟錯，個股頁面顯示「資料暫缺」即可。
 */
export async function getMarketDepth(symbolInput: string, marketHint?: Market): Promise<MarketDepth | null> {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  if (market !== "TW") return null;
  return cached(`market-depth:${symbol}`, MARKET_DEPTH_TTL_MS, () =>
    fetchYahooTwMarketDepth(symbol, resolveTwExchange(symbol))
  );
}

// 2026-09-20：拉長到 15 分鐘——重大訊息公告比籌碼/財報更可能在盤中臨時出現，
// 保留比其他基本面資料更短的間隔，但一樣不需要5分鐘等級的新鮮度。
const ANNOUNCEMENTS_TTL_MS = 15 * 60_000;

/** TW only — 最近一個交易日的重大訊息公告；大多數股票當天沒有公告是常態，回傳空陣列而非 null。 */
export async function getMaterialAnnouncements(symbolInput: string, marketHint?: Market): Promise<MaterialAnnouncement[]> {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  if (market !== "TW") return [];
  try {
    const map = await cachedMap("announcements:TW:all", ANNOUNCEMENTS_TTL_MS, () =>
      mergeTwMaps(fetchTwseMaterialAnnouncementsAll, fetchTpexMaterialAnnouncementsAll)
    );
    return map.get(symbol) ?? [];
  } catch {
    return [];
  }
}

// "美股四大指數" as this site's Taiwanese audience means it: 道瓊/S&P 500/
// 那斯達克 plus 費城半導體指數（SOX）— the semiconductor-heavy Philadelphia
// index is the conventional 4th "major" one watched alongside the other
// three specifically in Taiwan financial media, given how closely TW's own
// market (TSMC and the broader chip supply chain) tracks it; it is not one
// of the "big 3" in a purely US context, which is why it was missing here.
const INDEX_DEFS: Array<{ symbol: string; name: string; market: Market; misCode?: string }> = [
  { symbol: "TAIEX", name: "台股加權指數", market: "TW", misCode: "t00" },
  { symbol: "^DJI", name: "道瓊工業指數", market: "US" },
  { symbol: "^GSPC", name: "S&P 500", market: "US" },
  { symbol: "^IXIC", name: "那斯達克指數", market: "US" },
  { symbol: "^SOX", name: "費城半導體指數", market: "US" },
];

/**
 * Only includes indices that were actually fetched successfully — an
 * index that failed to load is simply omitted rather than shown with a
 * substitute value.
 *
 * Each index is cached under its own key rather than one "indices" key for
 * the whole array: with a single shared key, one bad moment where all four
 * upstream calls happened to fail at once cached an *empty* array for the
 * full TTL, blanking the homepage's index cards for 20s even if upstream
 * had already recovered a moment later. Per-index keys mean a transient
 * failure only withholds that one index for its own TTL, and doesn't touch
 * whatever the others most recently succeeded with.
 */
export async function getIndices(): Promise<IndexQuote[]> {
  const results = await Promise.all(
    INDEX_DEFS.map((def) =>
      // 逐檔用自己市場的 TTL：台股指數盤中 10 秒、美股指數維持 20 秒，
      // 不會因為放在同一個 getIndices() 就把台股規則套到美股指數上。
      cached<IndexQuote | null>(`index:${def.symbol}`, quoteTtlMs(def.market), async () => {
        try {
          const q =
            def.market === "TW" && def.misCode ? await fetchTwseQuote(def.misCode) : await fetchUsQuote(def.symbol);
          return { symbol: def.symbol, name: def.name, market: def.market, price: q.price, change: q.change, changePercent: q.changePercent };
        } catch {
          return null;
        }
      })
    )
  );
  return results.filter((r): r is IndexQuote => r !== null);
}

/**
 * 台指期（TX，大台指）夜盤近月合約報價——見 lib/data/taifex.ts 開頭的完整資料源
 * 研究說明。跟 getIndices() 分開一個函式（而不是塞進 INDEX_DEFS），是因為這個
 * 資料需要額外的 status/asOf 欄位才能誠實呈現「交易中」跟「已收盤」的差異，
 * IndexQuote 型別沒有這兩個欄位。快取沿用跟其他即時報價一樣的 QUOTE_TTL_MS，
 * 抓不到（含近月合約還沒開出成交價）一律回傳 null，不用參考價頂替。
 */
export async function getTaifexNightFutures(): Promise<TaifexFuturesQuote | null> {
  return cached<TaifexFuturesQuote | null>("taifex:tx-night", QUOTE_TTL_MS, async () => {
    try {
      return await fetchTaifexNightFutures();
    } catch {
      return null;
    }
  });
}

/**
 * All of a market's universe quotes in one batched network call (plus a
 * per-symbol fallback for whatever the batch didn't cover), cached and
 * shared across every caller — search page, both market tabs, homepage
 * movers, highlights boards, and the daily brief all hit the same cached
 * map instead of each re-fetching (or worse, each firing 20+ of their own
 * concurrent per-symbol requests, which is what made list pages show
 * mostly-stale/failed data even when single-stock pages were fetching real
 * quotes fine: TWSE/Yahoo's single-symbol endpoints aren't meant for that
 * many concurrent hits from one caller and tend to time out or get
 * throttled). Symbols that fail both the batch and the per-symbol retry
 * are simply absent from the map — never filled in with a guess.
 */
async function fetchMarketQuoteMap(market: Market): Promise<Map<string, Quote>> {
  const pool = await universeFor(market);
  const map = new Map<string, Quote>();

  if (market === "TW") {
    // Two separate exchanges behind one "TW" batch: each gets its own
    // request and its own try/catch so a TWSE or TPEx outage only costs
    // that exchange's symbols, not the whole TW screen. TPEx's own batch
    // fetch is always ONE whole-market request regardless of how many TPEx
    // symbols are in `pool` (see tpex.ts's fetchTpexQuoteSnapshot) — unlike
    // TWSE's, it isn't chunked/concurrency-sensitive at all.
    const twsePool = pool.filter((e) => e.exchange !== "TPEx").map((e) => e.symbol);
    const tpexPool = pool.filter((e) => e.exchange === "TPEx").map((e) => e.symbol);
    const [twseBatch, tpexBatch] = await Promise.all([
      fetchTwseQuotesBatch(twsePool).catch(() => new Map<string, Quote>()),
      fetchTpexQuotesBatch(tpexPool).catch(() => new Map<string, Quote>()),
    ]);
    for (const [symbol, quote] of twseBatch) map.set(symbol, quote);
    for (const [symbol, quote] of tpexBatch) map.set(symbol, quote);
  } else {
    try {
      const batch = await fetchUsQuotesBatch(pool.map((e) => e.symbol));
      for (const [symbol, quote] of batch) map.set(symbol, quote);
    } catch {
      // batch endpoint failed outright; every symbol falls through to the
      // per-symbol attempt below instead
    }
  }

  // Only bother retrying individually when a small number slipped through
  // the batch — if the batch failed wholesale or missed a lot of symbols,
  // firing dozens+ of concurrent single-symbol requests on top of it risks
  // getting the whole site rate-limited by TWSE/Yahoo (breaking unrelated
  // single-stock lookups too), for a screen that only shows a handful of
  // rows anyway. Those symbols are just omitted, same as any other
  // unreachable quote.
  const MAX_SINGLE_RETRIES = 15;
  const missing = pool.filter((e) => !map.has(e.symbol));
  if (missing.length > 0 && missing.length <= MAX_SINGLE_RETRIES) {
    const singles = await Promise.all(
      missing.map(async (entry): Promise<[string, Quote] | null> => {
        try {
          const q =
            market === "TW"
              ? entry.exchange === "TPEx"
                ? await fetchTpexQuote(entry.symbol)
                : await fetchTwseQuote(entry.symbol)
              : await fetchUsQuote(entry.symbol);
          return [entry.symbol, q];
        } catch {
          return null;
        }
      })
    );
    for (const s of singles) {
      if (s) map.set(s[0], s[1]);
    }
  }

  // Fire-and-forget, piggybacked on this same batch fetch rather than a
  // separate schedule or per-symbol call — see volumeHistory.ts for why this
  // is the "compute the whole-market volume trend cheaply" design: it's a
  // small conditional Redis read+write, not an extra upstream request, and
  // it internally no-ops except once per real trading day. Never awaited so
  // it can't add latency to (or, via its own try/catch, ever fail) this
  // already-expensive batch quote fetch.
  void maybeRecordDailyVolumeSnapshot(market, map);

  return map;
}

// A one-time backfill's per-symbol chart fetch is a *month* of a stock's own
// history — a bigger single request than a live quote — so it runs at a more
// conservative concurrency than MOMENTUM_CHART_CONCURRENCY below (that one
// only ever covers 15 candidates at a time, not the whole market).
const VOLUME_BACKFILL_CHART_CONCURRENCY = 15;

/**
 * One-time seed for volumeHistory.ts's trailing-average cache, run via
 * /api/cron/backfill-volume-history rather than automatically: reuses each
 * symbol's own historical daily chart (already available today via
 * getChart, spanning months) instead of waiting
 * MIN_HISTORY_DAYS_FOR_AVERAGE real trading days for
 * maybeRecordDailyVolumeSnapshot to accumulate enough live snapshots from
 * scratch. `offset`/`limit` slice the market's universe so one call stays
 * comfortably inside a serverless function's execution budget — the caller
 * (the cron route) loops across pages rather than this function trying to
 * cover an ~950-symbol market in one shot.
 */
export async function backfillVolumeHistory(
  market: Market,
  { offset = 0, limit = 200 }: { offset?: number; limit?: number } = {}
): Promise<{ seeded: number; covered: number; total: number; nextOffset: number | null }> {
  const pool = await universeFor(market);
  const page = pool.slice(offset, offset + limit);
  const candlesBySymbol = new Map<string, Candle[]>();

  await mapWithConcurrency(page, VOLUME_BACKFILL_CHART_CONCURRENCY, async (entry) => {
    const chart = await getChart(entry.symbol, "1m", market).catch(() => null);
    if (chart && chart.candles.length > 0) candlesBySymbol.set(entry.symbol, chart.candles);
  });

  const { seeded } = await backfillVolumeHistoryFromCandles(market, candlesBySymbol);
  const nextOffset = offset + limit < pool.length ? offset + limit : null;
  return { seeded, covered: page.length, total: pool.length, nextOffset };
}

// Deliberately much longer than QUOTE_TTL_MS (used for a single symbol's
// "live" quote while actively watching its page). This is the whole-universe
// batch fetch behind search/highlights/homepage rankings — by far the most
// expensive upstream call in the app — and a personal browsing tool doesn't
// need second-by-second freshness on a ranking list the way a single quote
// being actively watched does. At 20s, any real visit more than 20s after
// the last one (i.e. essentially every normal visit, since people don't
// click faster than that) missed the cache and paid the full TWSE/Yahoo
// batch-fetch cost — which is what made every highlights/search visit feel
// slow regardless of how fast the code computing on top of it was.
const MARKET_MAP_TTL_MS = 2 * 60_000;

/**
 * 台股 08:30~14:30 期間縮短到 60 秒。首頁「焦點排行」盤中每 10 秒輪詢一次
 * /api/search，若這份全市場快取還是 2 分鐘，畫面上的漲跌幅最久要 2 分鐘才會
 * 換一次數字，跟使用者要的「盤中即時」差太多。
 *
 * 但也**刻意不跟著縮到 10 秒**：這是全站最貴的一次上游呼叫（整個市場的批次
 * 報價），PROGRESS.md 2026-09-11 那次效能事故就是因為這份資料只快取 20 秒，
 * 導致幾乎每一次瀏覽都要現場付整批抓取的成本、全站變慢。60 秒是「盤中數字
 * 會動」跟「不要重演那次變慢」之間的取捨：焦點排行實際最快每分鐘換一次數字，
 * 個股報價/大盤指數/關注清單那些單檔報價則是真正的 10 秒級。
 */
const TW_LIVE_MARKET_MAP_TTL_MS = 60_000;

// cachedMap, not cached: this value is a Map, and the Redis backend stores
// JSON — a Map would come back from a shared-cache hit as an empty object.
async function getMarketQuoteMap(market: Market): Promise<Map<string, Quote>> {
  const ttl = market === "TW" && isTwQuoteWindow() ? TW_LIVE_MARKET_MAP_TTL_MS : MARKET_MAP_TTL_MS;
  return cachedMap(`market-quotes:${market}`, ttl, () => fetchMarketQuoteMap(market));
}

export interface SearchFilters {
  market?: Market;
  /** @deprecated use `sectors` (supports multi-select) */
  sector?: string;
  sectors?: string[];
  query?: string;
  minChangePercent?: number;
  maxChangePercent?: number;
  minPrice?: number;
  maxPrice?: number;
  minVolume?: number;
  maxVolume?: number;
  minTurnover?: number;
  maxTurnover?: number;
  /**
   * 多選，跟 `sectors` 同一套「不衝突條件可以複選」的設計：不傳或空陣列＝不篩選；
   * 傳了就只保留 volumeTrend 落在這個集合裡的股票。見 types.ts 的 VolumeTrend /
   * SearchItem.volumeTrend 說明——這是價量關係推論，不是真實買賣單量能分類。
   */
  volumeTrends?: VolumeTrend[];
  sortBy?: "changePercent" | "volume" | "price" | "turnover";
  sortDir?: "asc" | "desc";
}

/** Stocks with no live quote available are excluded, never shown with a placeholder price. */
export async function searchStocks(filters: SearchFilters): Promise<SearchItem[]> {
  let pool: UniverseEntry[] = filters.market
    ? await universeFor(filters.market)
    : [...(await getTwUniverse()), ...US_UNIVERSE];
  if (filters.sector) pool = pool.filter((e) => e.sector === filters.sector);
  if (filters.sectors && filters.sectors.length > 0) {
    const wanted = new Set(filters.sectors);
    pool = pool.filter((e) => wanted.has(e.sector));
  }
  if (filters.query) {
    const q = filters.query.trim().toLowerCase();
    pool = pool.filter((e) => e.symbol.toLowerCase().includes(q) || e.name.toLowerCase().includes(q));
  }

  const marketsNeeded = [...new Set(pool.map((e) => e.market))];
  const [quoteMaps, avgVolumeMaps] = await Promise.all([
    Promise.all(marketsNeeded.map((m) => getMarketQuoteMap(m))),
    // Cheap (peekCached, read-only — see volumeHistory.ts): never triggers a
    // fresh computation, just reads whatever the batch-quote piggyback has
    // already accumulated. A market with no history yet just yields an
    // empty map, and every item's volumeTrend falls back to "neutral".
    Promise.all(marketsNeeded.map((m) => getTrailingAverageVolumeMap(m))),
  ]);
  const quoteBySymbol = new Map<string, Quote>();
  const avgVolumeBySymbol = new Map<string, number>();
  marketsNeeded.forEach((m, i) => {
    for (const [symbol, quote] of quoteMaps[i]) quoteBySymbol.set(`${m}:${symbol}`, quote);
    for (const [symbol, avg] of avgVolumeMaps[i]) avgVolumeBySymbol.set(`${m}:${symbol}`, avg);
  });

  let items: SearchItem[] = pool
    .map((entry): SearchItem | null => {
      const q = quoteBySymbol.get(`${entry.market}:${entry.symbol}`);
      if (!q) return null;
      const avgVolume = avgVolumeBySymbol.get(`${entry.market}:${entry.symbol}`);
      return {
        symbol: entry.symbol,
        market: entry.market,
        name: entry.name,
        sector: entry.sector,
        price: q.price,
        changePercent: q.changePercent,
        volume: q.volume,
        turnover: q.price * q.volume,
        ...computeVolumeMetrics(q.changePercent, q.volume, avgVolume),
      };
    })
    .filter((i): i is SearchItem => i !== null);

  if (filters.minChangePercent !== undefined) {
    items = items.filter((i) => i.changePercent >= filters.minChangePercent!);
  }
  if (filters.maxChangePercent !== undefined) {
    items = items.filter((i) => i.changePercent <= filters.maxChangePercent!);
  }
  if (filters.minPrice !== undefined) {
    items = items.filter((i) => i.price >= filters.minPrice!);
  }
  if (filters.maxPrice !== undefined) {
    items = items.filter((i) => i.price <= filters.maxPrice!);
  }
  if (filters.minVolume !== undefined) {
    items = items.filter((i) => i.volume >= filters.minVolume!);
  }
  if (filters.maxVolume !== undefined) {
    items = items.filter((i) => i.volume <= filters.maxVolume!);
  }
  if (filters.minTurnover !== undefined) {
    items = items.filter((i) => i.turnover >= filters.minTurnover!);
  }
  if (filters.maxTurnover !== undefined) {
    items = items.filter((i) => i.turnover <= filters.maxTurnover!);
  }
  if (filters.volumeTrends && filters.volumeTrends.length > 0) {
    const wantedTrends = new Set(filters.volumeTrends);
    items = items.filter((i) => wantedTrends.has(i.volumeTrend));
  }

  const sortBy = filters.sortBy ?? "changePercent";
  const sortDir = filters.sortDir ?? "desc";
  items.sort((a, b) => {
    const diff = a[sortBy] - b[sortBy];
    return sortDir === "desc" ? -diff : diff;
  });

  return items;
}

export interface MomentumItem extends SearchItem {
  signals: Signal[];
}

// Was doubled to 10 minutes at one point to reduce how often this
// genuinely expensive screen (a chart fetch per candidate stock) has to
// 2026-09-20：拉長到 15 分鐘——這是這支排程裡數一數二貴的一項（要對候選股
// 各抓一次K線），warm-cache 的背景排程本來就每5分鐘觸發一次，TTL 定在5分鐘
// 等於每次觸發都重算，是 Vercel 用量吃緊後盤點出來的浪費源頭之一；15分鐘仍然
// 遠比技術訊號實際變化的速度（通常以「天」為單位）新鮮很多。
const MOMENTUM_TTL_MS = 15 * 60_000;
// Computing a signal requires a chart fetch per candidate stock, so the
// candidate pool is capped to the biggest movers by |change%| before doing
// that work — a board that only ever displays the top ~10 results doesn't
// need to chart-fetch the entire universe. Trimmed from 25: confirmed via
// local benchmark that this pool size barely moves the needle on a cold
// computation (see MOMENTUM_TTL_MS comment above) since TWSE round-trip
// latency dominates either way, so there was no reason to charter the
// larger pool.
const MOMENTUM_CANDIDATE_LIMIT = 15;
// How many candidates are charted at once. A TW chart fetch is itself
// several requests (one per calendar month), so this is the real knob on
// how hard this screen hits the upstreams. Kept above MOMENTUM_CANDIDATE_LIMIT
// so every candidate still runs in one fully-parallel batch (mapWithConcurrency
// clamps to the smaller of the two anyway).
const MOMENTUM_CHART_CONCURRENCY = 25;

/**
 * Stocks where 2+ objective technical signals (see lib/signals.ts) are
 * true at once — e.g. a volume spike happening alongside a break above
 * the 20-day MA. This is a screen over PAST/CURRENT data only; it is
 * deliberately not framed as "about to rise" or any other forward-looking
 * claim, which would cross into regulated investment-advice territory and
 * isn't something technical data can honestly support anyway.
 */
export async function getMultiSignalStocks(market: Market, minSignals = 2): Promise<MomentumItem[]> {
  return cached(`momentum:${market}:${minSignals}`, MOMENTUM_TTL_MS, async () => {
    const pool = await universeFor(market);
    const quoteMap = await getMarketQuoteMap(market);
    const avgVolumeMap = await getTrailingAverageVolumeMap(market);

    const candidates = pool
      .filter((entry) => quoteMap.has(entry.symbol))
      .sort((a, b) => Math.abs(quoteMap.get(b.symbol)!.changePercent) - Math.abs(quoteMap.get(a.symbol)!.changePercent))
      .slice(0, MOMENTUM_CANDIDATE_LIMIT);

    // Bounded, not Promise.all: each getChart() on a TW symbol fans out into
    // one request per calendar month, so charting all 25 candidates at once
    // meant ~100 simultaneous requests to TWSE for this single screen.
    const results = await mapWithConcurrency(
      candidates,
      MOMENTUM_CHART_CONCURRENCY,
      async (entry): Promise<MomentumItem | null> => {
        const quote = quoteMap.get(entry.symbol)!;
        const chart = await getChart(entry.symbol, "3m", entry.market);
        if (!chart) return null;
        const signals = computeSignals(chart.candles, quote.price, "3m");
        if (signals.length < minSignals) return null;
        return {
          symbol: quote.symbol,
          market: quote.market,
          name: quote.name,
          sector: entry.sector,
          price: quote.price,
          changePercent: quote.changePercent,
          volume: quote.volume,
          turnover: quote.price * quote.volume,
          ...computeVolumeMetrics(quote.changePercent, quote.volume, avgVolumeMap.get(entry.symbol)),
          signals,
        };
      }
    );

    return results
      .filter((r): r is MomentumItem => r !== null)
      .sort((a, b) => b.signals.length - a.signals.length);
  });
}

export interface TechScreenItem {
  symbol: string;
  market: Market;
  name: string;
  price: number;
  changePercent: number;
  turnover: number;
  /** 每個技術指標「當下的實際狀態值」，見 lib/signals.ts 的 IndicatorState。 */
  state: IndicatorState;
  /** 同一組 K 線算出來、已經觸發的中文訊號標籤（跟個股頁上顯示的完全一致）。 */
  signals: Signal[];
}

// 2026-09-20：拉長到 30 分鐘——這是全站最貴的一項背景計算（要對成交金額
// 前120檔台股+60檔美股各抓一次K線），5分鐘的 warm-cache 排程若每次都重算這個，
// 是 Vercel 免費方案用量吃緊後盤點出來的最大浪費源頭，30分鐘仍然遠比技術指標
// 交叉訊號實際變化的速度新鮮很多。
const TECH_SCREEN_TTL_MS = 30 * 60_000;
// 空結果（一檔都沒算出來）專用的短 TTL——見
// cachedListWithDegradedEmptyTtl() 的完整說明。
const TECH_SCREEN_DEGRADED_TTL_MS = 60_000;
// 掃描範圍：依今日成交金額（＝市場資金實際關注度）由大到小取前 N 檔。
//
// 為什麼不沿用 getMultiSignalStocks 那個「當日漲跌幅最大前15檔」的候選池：
// 使用者要求「問『有沒有MACD與KD都黃金交叉的股票』這種多重指標篩選時，要真的
// 去查證資料」。實測（2026-09-16）用獨立腳本掃描台股成交金額前150檔發現，當天
// 真的有一檔嘉基(6715) 同時符合 MACD 黃金交叉 + K值上穿D值，但它當天只漲 3.32%、
// 完全排不進全市場漲跌幅前15名，所以 getMultiSignalStocks 從一開始就不會把它
// 納入候選，AI 手上根本沒有這筆資料，只能誠實回答「沒有」——跟先前「連漲N天」
// 那個 bug 是同一個根因：**候選池的挑選標準（漲跌幅）跟使用者問的條件（技術
// 指標交叉）根本無關**。技術指標交叉天生就常發生在漲幅普通的股票上（MACD 剛
// 黃金交叉通常只是小漲一根），用漲跌幅當入場券等於系統性地把答案濾掉。
//
// 改用成交金額排序的理由：①它跟「有沒有發生交叉」完全無關，不會造成上述那種
// 系統性偏誤；②技術指標對幾乎沒有人交易的殭屍股本來就沒有參考價值（算得出
// 漂亮的黃金交叉也買不到、賣不掉），用流動性當門檻同時也是對使用者負責。
// 這仍然不是「全市場每一檔」（那需要對上千檔各抓一次K線，對上游是不可行的
// 請求量），所以清單本身、以及送進 AI 的說明文字都必須誠實標示掃描範圍。
const TECH_SCREEN_CANDIDATE_LIMIT: Record<Market, number> = { TW: 120, US: 60 };
// 抓K線的併發上限。跟 getVolumeSurgeStocks 用同一個量級（它已經在正式站穩定
// 跑 60 檔），且兩者候選池高度重疊、getChart 本身有快取，重複的部分是免費的。
const TECH_SCREEN_CHART_CONCURRENCY = 20;

/**
 * `cached()` 的變體：算出來是**空清單**時只給一個很短的 TTL，真的算出資料才
 * 給正常的長 TTL。
 *
 * 2026-09-20 正式站實際踩到的 bug：AI 問答被問「有沒有 MACD 跟 KD 都黃金交叉
 * 的股票」時，連續 30 分鐘以上都回答「資料裡沒有提供台股的技術指標篩選清單，
 * 只有美股的」——台股整個區塊憑空消失。根因不是計算太慢或逾時（實測台股前 120
 * 檔的 3 個月 K 線在併發 20 下只要約 10 秒、120/120 全部成功），而是：
 * `searchStocks({market:"TW"})` 在某個瞬間因為上游（TWSE/TPEx 報價或清單）
 * 暫時性降級而回傳 0 筆，`getTechnicalScreen("TW")` 於是算出 `[]`，這個 `[]`
 * 就被 `cached()` 當成正常結果**整整存活 30 分鐘**。更糟的是每 5 分鐘一次的
 * warm-cache 排程重新呼叫時只會讀到這份快取的 `[]`，不會重算，所以系統完全
 * 沒有自我修復的機會，只能乾等 TTL 到期。
 *
 * 這跟 universe.ts 早先修過的「TW_UNIVERSE_DEGRADED_TTL_MS」是同一類問題，
 * 做法也刻意跟那邊一致：用 peekCached/writeCached 自己決定要寫多長的 TTL，
 * 並自己補一個 single-flight 旗標（`cached()` 內建的去重在這裡用不到，而這兩
 * 份資料都很昂貴，沒有去重會讓多個同時進來的 cache miss 各自重跑一次全市場
 * 掃描）。空結果仍然會被短暫快取（而不是完全不快取），是為了避免上游真的掛掉
 * 時每一個請求都去重打一次全市場掃描。
 */
const degradedEmptyInFlight = new Map<string, Promise<unknown[]>>();

async function cachedListWithDegradedEmptyTtl<T>(
  key: string,
  ttlMs: number,
  degradedTtlMs: number,
  load: () => Promise<T[]>
): Promise<T[]> {
  const hit = await peekCached<T[]>(key);
  if (hit) return hit;
  const pending = degradedEmptyInFlight.get(key);
  if (pending) return (await pending) as T[];
  const promise = (async () => {
    const value = await load();
    await writeCached(key, value, value.length > 0 ? ttlMs : degradedTtlMs);
    return value;
  })();
  degradedEmptyInFlight.set(key, promise as Promise<unknown[]>);
  try {
    return await promise;
  } finally {
    degradedEmptyInFlight.delete(key);
  }
}

/**
 * 上一次真的重算 getTechnicalScreen 時的執行摘要（候選池幾檔、成功幾檔、
 * K線抓不到幾檔），給 /api/cron/warm-cache 回報用。
 *
 * 為什麼需要這個：2026-09-20 追「AI 說沒有台股技術指標清單」這個 bug 時，
 * 外面唯一看得到的訊息是「這份清單是空的」，完全無法分辨到底是「候選池
 * （searchStocks）本身就是 0 筆」還是「候選池有 120 檔但每一檔的 K 線都抓不
 * 到」——這兩種是完全不同的根因、要往完全不同的方向修。console.error 在正式
 * 站當下拿不到，只能靠反覆間接量測猜，浪費很多時間。把這個摘要留下來，之後
 * 同類問題可以直接看出是哪一段斷掉。
 */
const lastTechScreenRun: Record<string, string> = {};

export function getLastTechScreenRun(): Record<string, string> {
  return { ...lastTechScreenRun };
}

/**
 * 全市場（成交金額前 N 檔）的「每一檔技術指標實際狀態」快照，專門用來支援
 * 「多重技術指標同時符合」的篩選問題。
 *
 * 跟 getMultiSignalStocks 的關鍵差異有兩個：
 * 1. 候選池用成交金額而非當日漲跌幅挑（見上方 TECH_SCREEN_CANDIDATE_LIMIT 註解），
 *    範圍也大 8 倍，不會系統性漏掉漲幅普通但剛發生指標交叉的股票。
 * 2. 回傳的是結構化的指標數值（有沒有交叉、K/D 幾點、RSI 幾點、均線什麼排列），
 *    不是只有中文標籤字串，所以呼叫端可以用程式做任意組合的交集篩選
 *    （「MACD黃金交叉 且 KD黃金交叉」「均線多頭排列 且 RSI<70」…），
 *    而不是靠 AI 看著標籤自己猜。
 */
export async function getTechnicalScreen(market: Market): Promise<TechScreenItem[]> {
  return cachedListWithDegradedEmptyTtl(
    `tech-screen:${market}:v1`,
    TECH_SCREEN_TTL_MS,
    TECH_SCREEN_DEGRADED_TTL_MS,
    async () => {
      const pool = await searchStocks({ market, sortBy: "turnover", sortDir: "desc" });
      const candidates = pool.slice(0, TECH_SCREEN_CANDIDATE_LIMIT[market]);

      const results = await mapWithConcurrency(
        candidates,
        TECH_SCREEN_CHART_CONCURRENCY,
        async (item): Promise<TechScreenItem | null> => {
          // 逐檔各自 try/catch：mapWithConcurrency 底下是 Promise.all，任何一檔
          // 拋例外就會讓「整個市場」的篩選結果一起變成 rejected，呼叫端
          // （buildTechScreenGrounding 的 .catch(() => [])）再把它吞成空陣列——
          // 結果就是 120 檔裡只要有 1 檔的 K 線抓取出錯，AI 就會回答「資料裡沒有
          // 台股的技術指標篩選清單」，而且因為錯誤被吞掉、外面完全看不出原因。
          // 單一檔抓不到就跳過那一檔（照 getChart 回傳 null 時本來就有的處理），
          // 才是正確的降級方式。
          try {
            const chart = await getChart(item.symbol, "3m", item.market);
            if (!chart) return null;
            const state = computeIndicatorState(chart.candles, item.price);
            if (!state) return null;
            return {
              symbol: item.symbol,
              market: item.market,
              name: item.name,
              price: item.price,
              changePercent: item.changePercent,
              turnover: item.turnover,
              state,
              signals: computeSignals(chart.candles, item.price, "3m"),
            };
          } catch (err) {
            console.error(`[tech-screen] ${item.market} ${item.symbol} 指標計算失敗，跳過這一檔：`, err);
            return null;
          }
        }
      );

      const kept = results.filter((r): r is TechScreenItem => r !== null);
      lastTechScreenRun[market] =
        `候選池 ${pool.length} 檔（取前 ${candidates.length}）→ 成功 ${kept.length} 檔、抓不到K線或指標算不出來 ${candidates.length - kept.length} 檔，於 ${new Date().toISOString()}`;
      return kept;
    }
  );
}

export interface VolumeSurgeItem {
  symbol: string;
  market: Market;
  name: string;
  price: number;
  changePercent: number;
  volumeRatio?: number;
  /** 從最新一天往回算的連續上漲/下跌天數，0代表今天走勢跟昨天相反或平盤（不成
   *  立連續），任何長度都會回傳（不像 MomentumItem 的訊號只在達到3天以上才會
   *  出現）——用意是讓 AI 問答能誠實回答「剛漲一天」「連漲兩天」這種低於3天
   *  門檻的問法，而不是因為只看得到 >=3 天的訊號就誤判成沒有資料。 */
  streakDays: number;
  streakDirection: "up" | "down" | null;
}

// 2026-09-20：拉長到 20 分鐘——一樣是要對候選股逐一抓K線的較貴計算，理由同
// MOMENTUM_TTL_MS/TECH_SCREEN_TTL_MS 的說明。
const VOLUME_SURGE_TTL_MS = 20 * 60_000;
// 空結果專用的短 TTL，理由同 TECH_SCREEN_DEGRADED_TTL_MS：這份清單的候選池
// 同樣來自 searchStocks，上游暫時性降級時一樣會算出空清單，一旦被當成正常
// 結果快取 20 分鐘，AI 問「價漲量增、連漲N天」就會在這段期間一律誤答「沒有
// 資料」——正是這個功能當初被使用者回報的那個 bug 的表現方式。
const VOLUME_SURGE_DEGRADED_TTL_MS = 60_000;
// 這裡刻意跟 getMultiSignalStocks 的做法不同：先用完全不用抓K線、成本很低的
// searchStocks({volumeTrends:["buy-leaning"]})（只靠已經有的報價+近期均量快取）
// 掃過「整個台股市場」找出真正符合「今日價漲、且量能明顯高於自己均量」的股票，
// 不是像 momentum 那樣只從「當日漲跌幅最大的前15檔」這個很窄的池子裡挑——這正是
// 使用者實測抓到的真實bug根因：5251、3467 那天很可能都不在全市場當日漲跌幅前15名
// 之內，導致 getMultiSignalStocks 從一開始就不會把它們納入候選，AI 自然「查無資料」。
// 只有篩出「價漲量增」這個語意正確的候選集合之後，才對這個相對小很多的子集合
// （通常一天不會有數百檔同時符合價漲量增）逐一抓K線算連漲天數，把「大範圍篩選」
// 跟「昂貴的逐檔連漲天數計算」拆成兩個成本層級不同的步驟。
const VOLUME_SURGE_CANDIDATE_LIMIT = 60;
const VOLUME_SURGE_CHART_CONCURRENCY = 25;

/**
 * 真正的「今日價漲量增」全市場篩選（見上方 VolumeSurgeItem 註解的根因說明）：
 * 用 searchStocks 的 volumeTrends 篩選先掃出全市場符合「價漲量增」的股票，再對
 * 這個子集合逐檔算出連續上漲/下跌天數，讓 AI 問答可以誠實地依使用者指定的天數
 * （剛漲一天、連漲兩天、連漲三天...）從真實資料裡篩選回答，而不是只能回答固定
 * 一種天數門檻或直接說沒有資料。
 */
export async function getVolumeSurgeStocks(market: Market): Promise<VolumeSurgeItem[]> {
  return cachedListWithDegradedEmptyTtl(
    `volume-surge:${market}:v1`,
    VOLUME_SURGE_TTL_MS,
    VOLUME_SURGE_DEGRADED_TTL_MS,
    async () => {
      const pool = await searchStocks({ market, volumeTrends: ["buy-leaning"], sortBy: "turnover", sortDir: "desc" });
      const candidates = pool.slice(0, VOLUME_SURGE_CANDIDATE_LIMIT);

      const results = await mapWithConcurrency(
        candidates,
        VOLUME_SURGE_CHART_CONCURRENCY,
        async (item): Promise<VolumeSurgeItem | null> => {
          // 逐檔容錯，理由同 getTechnicalScreen 裡的說明：一檔出錯不該讓整份
          // 「價漲量增」清單變成空的，那正是使用者當初回報的「明明有股票卻被
          // 誤答沒有資料」的表現方式。
          try {
            const chart = await getChart(item.symbol, "1m", item.market);
            if (!chart) return null;
            const streak = computeStreak(chart.candles);
            return {
              symbol: item.symbol,
              market: item.market,
              name: item.name,
              price: item.price,
              changePercent: item.changePercent,
              volumeRatio: item.volumeRatio,
              streakDays: streak.days,
              streakDirection: streak.direction,
            };
          } catch (err) {
            console.error(`[volume-surge] ${item.market} ${item.symbol} 連漲天數計算失敗，跳過這一檔：`, err);
            return null;
          }
        }
      );

      return results
        .filter((r): r is VolumeSurgeItem => r !== null)
        .sort((a, b) => b.streakDays - a.streakDays);
    }
  );
}

export interface ValueScreenItem {
  symbol: string;
  market: Market;
  name: string;
  sector: string;
  price: number;
  changePercent: number;
  turnover: number;
  peRatio?: number;
  pbRatio?: number;
  dividendYield?: number;
}

/** 一次算好幾種「估值/跌幅」面向的全市場篩選結果，見 getValueScreen()。 */
export interface ValueScreen {
  lowPe: ValueScreenItem[];
  highYield: ValueScreenItem[];
  lowPb: ValueScreenItem[];
  decliners: ValueScreenItem[];
}

// 2026-09-20：拉長到 30 分鐘，跟本益比/殖利率背後的 FUNDAMENTALS_TTL_MS 對齊
// ——這個排行本身不用抓K線（只是重新排序已經快取好的基本面/報價資料），沒有
// MOMENTUM/TECH_SCREEN 那麼貴，但排序依據的本益比/殖利率一天也不會變好幾次。
const VALUE_SCREEN_TTL_MS = 30 * 60_000;
const VALUE_SCREEN_N = 12;
// 流動性下限：本益比/殖利率最極端的名次幾乎一定被「幾乎沒有人交易的殭屍股」佔滿
// （成交金額只有幾萬元的冷門股，本益比 2 倍也買不到、賣不掉），對使用者完全沒有
// 參考價值，還會讓回答看起來像在亂推薦。用「今日成交金額」當門檻，只保留真的有人
// 在交易的股票。3000 萬元大約是台股每天成交金額排行的中段，能濾掉極端冷門股又不會
// 嚴格到只剩權值股。
const VALUE_SCREEN_MIN_TURNOVER_TWD = 30_000_000;

/**
 * 全市場「便宜/高息/跌深」篩選。
 *
 * 加這個函式的原因跟 getVolumeSurgeStocks 是同一類問題：使用者實測問「有沒有本益比
 * 低的股票可以推薦？」「殖利率高的股票有哪些？」「今天跌最多的有哪些？有沒有跌深可以
 * 撿的？」時，AI 回答「資料裡沒有直接提供個股的本益比/殖利率數據」——但本站其實
 * 早就有全市場的本益比/股價淨值比/殖利率（TWSE 的 BWIBBU_ALL 加上 TPEx 的對應
 * 端點，見 getFundamentals 用的那份 `fundamentals:TW:all` 快取，一次就涵蓋整個市場），
 * 只是從來沒有任何地方把它整理成「排行清單」餵給 AI 問答，AI 手上真的沒有這份資料，
 * 才誠實說沒有。這就是典型的「明明有資料卻答沒有」——不是 AI 在說謊，是資料沒送到。
 *
 * 只做台股：美股的基本面是逐檔跟 Yahoo 拿的（fetchUsFundamentals），沒有一次拿到
 * 全市場的批次端點，硬要掃會變成上百個請求。
 */
export async function getValueScreen(market: Market): Promise<ValueScreen> {
  if (market !== "TW") return { lowPe: [], highYield: [], lowPb: [], decliners: [] };
  return cached(`value-screen:${market}:v1`, VALUE_SCREEN_TTL_MS, async () => {
    const [items, fundamentalsMap] = await Promise.all([
      searchStocks({ market, sortBy: "turnover", sortDir: "desc" }),
      cachedMap("fundamentals:TW:all", FUNDAMENTALS_TTL_MS, () =>
        mergeTwMaps(fetchTwseFundamentalsAll, fetchTpexFundamentalsAll)
      ),
    ]);

    const liquid = items.filter((i) => i.turnover >= VALUE_SCREEN_MIN_TURNOVER_TWD);
    const enriched: ValueScreenItem[] = liquid.map((i) => {
      const f = fundamentalsMap.get(i.symbol);
      return {
        symbol: i.symbol,
        market: i.market,
        name: i.name,
        sector: i.sector,
        price: i.price,
        changePercent: i.changePercent,
        turnover: i.turnover,
        peRatio: f?.peRatio,
        pbRatio: f?.pbRatio,
        dividendYield: f?.dividendYield,
      };
    });

    const byPe = enriched
      .filter((i) => i.peRatio != null && i.peRatio > 0)
      .sort((a, b) => a.peRatio! - b.peRatio!)
      .slice(0, VALUE_SCREEN_N);
    const byYield = enriched
      .filter((i) => i.dividendYield != null && i.dividendYield > 0)
      .sort((a, b) => b.dividendYield! - a.dividendYield!)
      .slice(0, VALUE_SCREEN_N);
    const byPb = enriched
      .filter((i) => i.pbRatio != null && i.pbRatio > 0)
      .sort((a, b) => a.pbRatio! - b.pbRatio!)
      .slice(0, VALUE_SCREEN_N);
    // 跌幅榜刻意不套流動性門檻以外的條件：使用者問「今天跌最多的」就是要看真實的
    // 跌幅排行，不是我們挑過的「跌得有道理的」。
    const decliners = enriched
      .filter((i) => i.changePercent < 0)
      .sort((a, b) => a.changePercent - b.changePercent)
      .slice(0, VALUE_SCREEN_N);

    return { lowPe: byPe, highYield: byYield, lowPb: byPb, decliners };
  });
}

export interface ChipsRankingItem {
  symbol: string;
  market: Market;
  name: string;
  price: number;
  changePercent: number;
  netShares: number;
}

/** 全市場三大法人/外資買賣超排行，見 getChipsRanking()。 */
export interface ChipsRanking {
  institutionalBuy: ChipsRankingItem[];
  institutionalSell: ChipsRankingItem[];
  foreignBuy: ChipsRankingItem[];
  foreignSell: ChipsRankingItem[];
  trustBuy: ChipsRankingItem[];
}

// 2026-09-20：拉長到 1 小時，跟 CHIPS_TTL_MS 對齊——這個排行的依據（三大法人
// 買賣超）本身就是收盤後才公布一次的報表，理由同 CHIPS_TTL_MS 的說明。
const CHIPS_RANKING_TTL_MS = 60 * 60_000;
const CHIPS_RANKING_N = 10;

/**
 * 全市場「三大法人/外資/投信買賣超排行」。
 *
 * 跟 getValueScreen 同一個成因：使用者問「三大法人今天在買什麼？」「今天外資買超最多的
 * 是哪幾檔？」時，AI 只能從「技術訊號共振股」那 12 檔（先天只取當日漲跌幅最大的前 15 檔
 * 當候選）附帶的籌碼欄位裡挑，於是把幾檔剛好爆量漲停的小型股講成「法人today在買的股票」，
 * 或老實回答「資料裡沒有特別列出外資買超最多的幾檔」。但 getChips 底下那兩份
 * `chips:TW:institutional` / `chips:TW:margin` 快取本來就是**全市場**的對照表（TWSE 加
 * TPEx 每個交易日的完整三大法人買賣超），要排行只是排序而已，不需要任何新的資料源。
 *
 * 只做台股：美股沒有對應的公開籌碼資料源（getChips 對美股一律回傳 null）。
 */
export async function getChipsRanking(market: Market): Promise<ChipsRanking> {
  const empty: ChipsRanking = {
    institutionalBuy: [],
    institutionalSell: [],
    foreignBuy: [],
    foreignSell: [],
    trustBuy: [],
  };
  if (market !== "TW") return empty;
  return cached(`chips-ranking:${market}:v1`, CHIPS_RANKING_TTL_MS, async () => {
    const [items, institutionalMap] = await Promise.all([
      searchStocks({ market, sortBy: "turnover", sortDir: "desc" }),
      cachedMap("chips:TW:institutional", CHIPS_TTL_MS, () =>
        mergeTwMaps(fetchTwseInstitutionalTradingAll, fetchTpexInstitutionalTradingAll)
      ),
    ]);

    // 排行只涵蓋「站上有即時報價的股票」，這樣每一筆都能附上現價與今日漲跌幅，
    // 不會出現只有買賣超股數、沒有價格的半套資料。
    const rows = items
      .map((i) => ({ item: i, chips: institutionalMap.get(i.symbol) }))
      .filter((r): r is { item: (typeof items)[number]; chips: Chips } => r.chips != null);

    const rank = (pick: (c: Chips) => number | undefined, dir: "buy" | "sell"): ChipsRankingItem[] =>
      rows
        .map((r) => ({ r, net: pick(r.chips) }))
        .filter((x): x is { r: (typeof rows)[number]; net: number } =>
          x.net != null && (dir === "buy" ? x.net > 0 : x.net < 0)
        )
        .sort((a, b) => (dir === "buy" ? b.net - a.net : a.net - b.net))
        .slice(0, CHIPS_RANKING_N)
        .map(({ r, net }) => ({
          symbol: r.item.symbol,
          market: r.item.market,
          name: r.item.name,
          price: r.item.price,
          changePercent: r.item.changePercent,
          netShares: net,
        }));

    return {
      institutionalBuy: rank((c) => c.institutionalNetShares, "buy"),
      institutionalSell: rank((c) => c.institutionalNetShares, "sell"),
      foreignBuy: rank((c) => c.foreignNetShares, "buy"),
      foreignSell: rank((c) => c.foreignNetShares, "sell"),
      trustBuy: rank((c) => c.trustNetShares, "buy"),
    };
  });
}
