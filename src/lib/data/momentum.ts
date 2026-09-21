import { cached, mapWithConcurrency } from "./cache";
import type { Market, SearchItem } from "./types";
import { computeSignals, type Signal } from "@/lib/signals";
import { universeFor } from "./symbols";
import { getMarketQuoteMap } from "./marketQuoteMap";
import { getChart } from "./chart";
import { computeVolumeMetrics, getTrailingAverageVolumeMap } from "./volumeHistory";

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
