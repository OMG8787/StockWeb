import { cachedWithDegradedNullTtl } from "@/lib/data/degradedCache";
import { mapWithConcurrency } from "@/lib/data/cache";
import { fetchUsCandles } from "@/lib/data/us";
import { resolveTwExchange } from "@/lib/data/symbols";
import { findInUniverse } from "@/lib/data/universe";
import type { Candle } from "@/lib/data/types";
import type { BacktestSeries } from "./backtest";

/**
 * 回測用的長期日K（5 年）：Yahoo 一檔一次請求（台股上市 .TW、上櫃 .TWO），結果快取 12 小時（記憶體＋Redis，一檔一個鍵）。
 * 不用證交所逐月 API：3 年要 37 個月份請求／檔，一次回測 20 檔就是 700 多個請求，會被證交所限流（見 CLAUDE.md）。
 * Yahoo 的收盤價只做分割調整、不含股息（回測報酬也就不含股息，畫面註明）。
 */
const HIST_TTL_MS = 12 * 3_600_000;
const HIST_FAIL_TTL_MS = 10 * 60_000;
/** 一次回測最多幾檔 */
export const BACKTEST_MAX_SYMBOLS = 30;

export async function getBacktestCandles(symbol: string, market: "TW" | "US"): Promise<Candle[] | null> {
  return cachedWithDegradedNullTtl<Candle[]>(`bt-hist:v1:${market}:${symbol}`, HIST_TTL_MS, HIST_FAIL_TTL_MS, async () => {
    if (market === "US") return fetchUsCandles(symbol, "5y").catch(() => null);
    const tpex = resolveTwExchange(symbol) === "TPEx";
    const order = tpex ? [".TWO", ".TW"] : [".TW", ".TWO"];
    for (const suffix of order) {
      const c = await fetchUsCandles(`${symbol}${suffix}`, "5y").catch(() => null);
      if (c && c.length > 0) return c;
    }
    return null;
  });
}

export async function loadBacktestSeries(symbols: Array<{ symbol: string; market: "TW" | "US" }>): Promise<BacktestSeries[]> {
  const list = symbols.slice(0, BACKTEST_MAX_SYMBOLS);
  const out = await mapWithConcurrency(list, 4, async (s) => {
    const candles = await getBacktestCandles(s.symbol, s.market);
    const name = (s.market === "TW" ? findInUniverse(s.symbol, "TW")?.name : undefined) ?? s.symbol;
    return { symbol: s.symbol, market: s.market, name, candles: candles ?? [] };
  });
  return out;
}
