import { cached } from "./cache";
import type { Candle, ChartRange, ChartResponse, Market } from "./types";
import { fetchTwseCandles } from "./twse";
import { fetchTpexCandles } from "./tpex";
import { fetchEmergingCandles } from "./emerging";
import { fetchUsCandles, fetchYahooIntradayCandles } from "./us";
import { detectMarket, normalizeSymbol, resolveTwExchange } from "./symbols";

const CHART_TTL_MS = 5 * 60_000;
// The "today" intraday range updates roughly once a minute at the source
// (Yahoo's own 1-minute bars) — a 5-minute TTL would show the same stale
// snapshot for several new bars in a row, defeating the point of an
// intraday view. 60s keeps it genuinely near-live without re-fetching for
// every single poll of a chart a user might have open.
const INTRADAY_CHART_TTL_MS = 60_000;

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
