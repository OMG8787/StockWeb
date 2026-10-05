import { cachedListWithDegradedEmptyTtl } from "@/lib/data/degradedCache";
import { fetchUsCandles } from "@/lib/data/us";
import type { Candle } from "@/lib/data/types";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { classifyRegime, marketReturnPct, type MarketRegime } from "./regime";

/** 加權指數在 Yahoo 的代號（marketHistory.ts 也用這個）。 */
export const TAIEX_YAHOO_SYMBOL = "^TWII";
const TAIEX_CANDLES_TTL_MS = 60 * 60_000;
const TAIEX_DEGRADED_TTL_MS = 60_000;

/** 加權指數 6 個月日K（一天一次快取，評等與獎勵計算共用；抓不到回空陣列）。 */
export function getTaiexCandles(): Promise<Candle[]> {
  return cachedListWithDegradedEmptyTtl<Candle>(`learning:taiex:6m:${taipeiDayKey()}`, TAIEX_CANDLES_TTL_MS, TAIEX_DEGRADED_TTL_MS, async () => {
    try {
      return await fetchUsCandles(TAIEX_YAHOO_SYMBOL, "6m");
    } catch {
      return [];
    }
  });
}

/** 加權指數近 60 個交易日報酬（%，弱市況提示用）；抓不到回 null（fail open，不提示）。 */
export async function getTaiexRet60Pct(): Promise<number | null> {
  const candles = await getTaiexCandles().catch(() => [] as Candle[]);
  return marketReturnPct(candles.map((c) => c.close));
}

/** 目前台股市況（多頭／空頭／盤整）；指數日K抓不到時 null（fail open，不影響評等）。 */
export async function getMarketRegime(): Promise<MarketRegime | null> {
  const candles = await getTaiexCandles().catch(() => [] as Candle[]);
  return classifyRegime(candles.map((c) => c.close));
}
