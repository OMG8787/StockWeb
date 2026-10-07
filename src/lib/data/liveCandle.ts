import type { Candle, Quote } from "./types";

/**
 * 盤中用即時價補「今天這根日K」（2026-10-07 使用者：「好，跟券商一致」）。
 *
 * 為什麼：官方日K（TWSE STOCK_DAY／TPEx）收盤後才有今天這一列，盤中最後一根是前一個交易日。
 * 券商 App 盤中會把現價當成今天的收盤、當日開高低與累計量當成今天這根K棒，再算 RSI／KD／MACD／均線，
 * 所以盤中同一檔本站與 App 的指標會差一整根（例：宏璟 10/7 盤中本站 KD 還停在 10/6 的死亡交叉）。
 *
 * 規則（純函式，有測試 src/__tests__/liveCandle.test.ts）：
 * - 只在「報價是今天（交易所所在地）的成交」時補：quote.tradeTime 的日期＝今天、成交量>0、開高低都有值（興櫃沒有開盤價，不補）。
 *   今天沒成交、假日、盤前試撮（沒有成交量）都回傳原陣列，不編造。
 * - 官方日K已經有今天這一列：盤中（marketOpen）以即時值覆蓋（跟券商一樣會隨價跳動）；收盤後官方為準、不動。
 * - 官方日K還沒有今天這一列：補一根（盤中、以及收盤後到官方公布之前這段，用最後成交價＝收盤價）。
 * - 補上的那根帶 `live: true`：量能比（爆量判斷）、評等的價位框架／追高防護／翻轉確認日都排除它（結論保護不變），
 *   只有 RSI／KD／MACD／均線／布林／連漲跌等指標吃它。
 */
export function dayKeyInZone(iso: string | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleDateString("en-CA", { timeZone });
}

export function exchangeTimeZone(market: "TW" | "US"): string {
  return market === "TW" ? "Asia/Taipei" : "America/New_York";
}

/** 交易所所在地今天的日期（yyyy-mm-dd）。 */
export function exchangeToday(market: "TW" | "US", now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: exchangeTimeZone(market) });
}

export function overlayLiveCandle(
  candles: Candle[],
  quote: Quote | null | undefined,
  opts: { marketOpen: boolean; now?: Date }
): Candle[] {
  if (!quote || quote.board === "emerging") return candles;
  const { open, high, low, price, volume } = quote;
  if (open == null || high == null || low == null || !(price > 0) || !(volume > 0)) return candles;
  const today = exchangeToday(quote.market, opts.now);
  if (dayKeyInZone(quote.tradeTime, exchangeTimeZone(quote.market)) !== today) return candles;
  const last = candles[candles.length - 1];
  if (last && last.time.slice(0, 10) > today) return candles;
  const hasToday = last != null && last.time.slice(0, 10) === today;
  if (hasToday && !opts.marketOpen) return candles; // 收盤後官方日K為準
  const live: Candle = {
    time: today,
    open,
    high: Math.max(high, price, open),
    low: Math.min(low, price, open),
    close: price,
    volume,
    live: true,
  };
  return hasToday ? [...candles.slice(0, -1), live] : [...candles, live];
}

/** 已收盤（沒有 live 標記）的日K：價位框架、追高防護、翻轉確認日、量能比用。 */
export function completedCandles(candles: Candle[]): Candle[] {
  return candles.length > 0 && candles[candles.length - 1].live ? candles.slice(0, -1) : candles;
}

/** 資料裡有 live 那根時，附在技術指標說明後面的程式字樣（AI 提到交叉／指標要照這個意思講）。 */
export const LIVE_BAR_INDICATOR_NOTE =
  "；注意：最後一根日K是今天盤中用即時價補上的（開高低＝今天盤中、收盤價＝目前成交價，跟券商 App 盤中的算法一致），所以下面的 RSI／KD／MACD／均線／交叉都是盤中訊號、收盤才確定，提到時要講「盤中」";
