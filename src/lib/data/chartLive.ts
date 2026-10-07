import { getChart, getChartWithWarmup } from "./chart";
import { getQuote } from "./quote";
import { overlayLiveCandle } from "./liveCandle";
import { getMarketStatus, marketScope } from "@/lib/marketStatus";
import { normalizeSymbol, detectMarket } from "./symbols";
import type { ChartRange, ChartResponse, Market, Quote } from "./types";

/**
 * 「算指標用」的日K唯一入口（2026-10-07 使用者要求跟券商一致）：官方日K（getChart）＋盤中／官方未公布前用即時價補的今天這根
 * （見 liveCandle.ts 的規則）。評等、技術篩選、即將交叉、AI 個股資料、圖表都吃這一個；回測用收盤日K（不經過這裡）。
 *
 * `opts.quote`：呼叫端手上已有同一檔的報價時帶進來（批次掃描用全市場報價表，不要每檔再打一次單檔報價）；
 * 沒帶（undefined）就用 getQuote（單檔報價快取，盤中 30 秒級、與四入口現價同一份）；帶 null＝明確不補。
 * 官方日K快取不動（5 分鐘），即時補的那根每次呼叫依報價快取重算，所以跟報價同步，不多打上游。
 * "today"（分時線）不處理。
 */
export async function getChartLive(
  symbolInput: string,
  range: ChartRange,
  marketHint?: Market,
  opts: { quote?: Quote | null } = {}
): Promise<ChartResponse | null> {
  const chart = await getChart(symbolInput, range, marketHint);
  if (!chart || range === "today" || chart.candles.length === 0) return chart;
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  const quote = opts.quote !== undefined ? opts.quote : await getQuote(symbol, market).catch(() => null);
  if (!quote) return chart;
  const marketOpen = getMarketStatus(marketScope(quote.market, quote.board)) === "open";
  const candles = overlayLiveCandle(chart.candles, quote, { marketOpen });
  return candles === chart.candles ? chart : { ...chart, candles };
}

/** /api/chart（圖表頁）用：顯示區間的日K含盤中即時補上的今天這根，暖機K線維持官方日K。 */
export async function getChartLiveWithWarmup(
  symbolInput: string,
  range: ChartRange,
  marketHint?: Market
): Promise<ChartResponse | null> {
  const base = await getChartWithWarmup(symbolInput, range, marketHint);
  if (!base || range === "today") return base;
  const live = await getChartLive(symbolInput, range, marketHint);
  return live ? { ...base, candles: live.candles } : base;
}
