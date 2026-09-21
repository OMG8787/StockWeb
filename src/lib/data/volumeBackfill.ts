import { mapWithConcurrency } from "./cache";
import type { Candle, Market } from "./types";
import { backfillVolumeHistoryFromCandles } from "./volumeHistory";
import { universeFor } from "./symbols";
import { getChart } from "./chart";

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
