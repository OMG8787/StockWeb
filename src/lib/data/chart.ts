import { cachedWithDegradedNullTtl } from "./degradedCache";
import { LIVE_CACHE_TTL_MS } from "@/lib/pollingSchedule";
import type { Candle, ChartRange, ChartResponse, Market } from "./types";
import { fetchTwseCandles } from "./twse";
import { fetchTpexCandles } from "./tpex";
import { fetchEmergingCandles } from "./emerging";
import { fetchUsCandles, fetchYahooIntradayCandles } from "./us";
import { detectMarket, normalizeSymbol, resolveTwExchange } from "./symbols";
import { liveSwrOptions } from "./swrPolicy";

const CHART_TTL_MS = 5 * 60_000;
// The "today" intraday range updates roughly once a minute at the source
// (Yahoo's own 1-minute bars) — a 5-minute TTL would show the same stale
// snapshot for several new bars in a row, defeating the point of an
// intraday view. 60s keeps it genuinely near-live without re-fetching for
// every single poll of a chart a user might have open.
const INTRADAY_CHART_TTL_MS = LIVE_CACHE_TTL_MS;
// 抓失敗（null）只快取 30 秒：TWSE 對連續請求會暫時回 428 限流，5y/10y 一次要打
// 60~120 個月份請求，任何一個月失敗整張圖就是 null。原本用 cached() 會把這個 null
// 當正常結果寫進共用 Redis 存活整個 5 分鐘，全站訪客都看到「無法取得」，即使上游
// 下一秒就恢復（2026-10-01 正式站實測 2330 5y 連續 503）。同 /api/indices 的修法。
const CHART_DEGRADED_TTL_MS = 30_000;

async function fetchTwChart(symbol: string, range: ChartRange): Promise<Candle[]> {
  const exchange = resolveTwExchange(symbol);
  if (exchange === "TPEx") return fetchTpexCandles(symbol, range);
  if (exchange === "Emerging") return fetchEmergingCandles(symbol, range);
  if (exchange === "TWSE") return fetchTwseCandles(symbol, range);
  try {
    return await fetchTwseCandles(symbol, range);
  } catch (err) {
    try {
      return await fetchTpexCandles(symbol, range);
    } catch {
      try {
        return await fetchEmergingCandles(symbol, range);
      } catch {
        throw err;
      }
    }
  }
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
  // 興櫃在 Yahoo 上跟上櫃共用 ".TWO" 後綴（實測 7893.TWO 有資料、7893.TW 直接
  // 404），所以這裡跟 TPEx 走同一條路。
  const first = exchange === "TPEx" || exchange === "Emerging" ? "TWO" : "TW";
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
  return cachedWithDegradedNullTtl<ChartResponse>(`chart:${market}:${symbol}:${range}`, ttl, CHART_DEGRADED_TTL_MS, async () => {
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
    } catch (err) {
      // 失敗原因記下來（只有HTTP狀態/上游網址，不含金鑰），/api/chart 的503會附上：
      // 正式站拿不到serverless log時，才分得出是限流、逾時還是別的原因。
      const message = err instanceof Error ? err.message : String(err);
      console.error("[chart] getChart failed:", symbol, range, message);
      lastChartFailure.set(`${market}:${symbol}:${range}`, message.slice(0, 300));
      if (lastChartFailure.size > 50) lastChartFailure.delete(lastChartFailure.keys().next().value as string);
      return null;
    }
  },
  // 只有當日走勢開 SWR：日K／3個月等區間會被技術篩選用 mapWithConcurrency 批次呼叫，
  // 若也「過期先回舊值、背景重抓」，背景重抓就不受併發上限管控，會一次對 TWSE
  // 打出上百個請求（cache.ts mapWithConcurrency 註解那種被限流的爆量）。
  range === "today" ? liveSwrOptions(market) : undefined);
}

const lastChartFailure = new Map<string, string>();
/** 最近一次這個股票/區間抓失敗的原因（同一個實例內），給 /api/chart 的503診斷用。 */
export function getLastChartFailure(symbolInput: string, range: ChartRange, marketHint?: Market): string | undefined {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  return lastChartFailure.get(`${market}:${symbol}:${range}`);
}
