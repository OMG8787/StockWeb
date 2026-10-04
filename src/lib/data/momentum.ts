import { cached, mapWithConcurrency } from "./cache";
import { HEAVY_SWR_MS } from "./swrPolicy";
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
// 2026-09-21 使用者實測反映：今日建議／AI問答的「技術訊號共振股」幾乎都是當天
// 漲停/大漲的標的，感覺像只看動能、不是真的整合多方資訊。查證後確認正是這裡的
// 候選池選法造成的——舊版用「當日漲跌幅絕對值」挑候選池，代表當天漲幅普通但技術
// 面/籌碼面/基本面其實不錯的股票，連被計算技術訊號的機會都沒有，一定進不了榜。
// 這正是 `techScreen.ts` 的 `getTechnicalScreen()` 早就改過的同一個問題（見那邊
// 的註解：「候選池用成交金額而非當日漲跌幅挑，不會系統性漏掉漲幅普通但剛發生
// 指標交叉的股票」），只是當時只修了那個函式，這個更早、用途更廣（同時餵今日
// 建議跟AI問答的「今日焦點」）的函式一直沒有跟著改。現在比照同一套解法：候選池
// 改用「今日成交金額」（跟漲跌幅完全無關的流動性指標）由大到小挑，範圍也對齊
// getTechnicalScreen 的規模，讓漲幅普通但確實活躍交易、技術面站得住腳的股票也有
// 機會被算進來，而不是被漲停股全部佔滿候選名額。
const MOMENTUM_CANDIDATE_LIMIT: Record<Market, number> = { TW: 120, US: 60 };
// How many candidates are charted at once. A TW chart fetch is itself
// several requests (one per calendar month), so this is the real knob on
// how hard this screen hits the upstreams. 跟 getTechnicalScreen 用同一個
// 已驗證過安全的併發值，候選池放大後沿用同一套節流設定。
const MOMENTUM_CHART_CONCURRENCY = 20;

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
      .sort((a, b) => {
        const qa = quoteMap.get(a.symbol)!;
        const qb = quoteMap.get(b.symbol)!;
        return qb.price * qb.volume - qa.price * qa.volume;
      })
      .slice(0, MOMENTUM_CANDIDATE_LIMIT[market]);

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
  }, { staleWhileRevalidateMs: HEAVY_SWR_MS });
}
