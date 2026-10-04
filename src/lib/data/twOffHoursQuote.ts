import { classifyTwQuoteTradeDate } from "@/lib/pollingSchedule";
import { getChart } from "./chart";
import { cachedMapWithDegradedShortTtl } from "./degradedCache";
import { fetchTwseDailyBarsAll } from "./twse";
import { fetchTpexDailyBarsAll } from "./tpex";
import type { Quote, TwDailyBar } from "./types";

/**
 * 非交易時段台股報價的「可信度閘門」——上市／上櫃報價（MIS）的唯一校正入口。
 *
 * 根因（2026-10-04 週日正式站實測）：MIS 在休市期間某些時段回的是「下一個交易日重置
 * 後／測試」狀態（2330 開高 2750＝漲停價、量 903 張且持續跳動；6488 價格每次載入都
 * 不同），rowToQuote 照單全收當成當日行情。判斷規則集中在 pollingSchedule.ts 的
 * classifyTwQuoteTradeDate()；這裡負責把不可信的那幾種狀態改用「最近一個交易日的
 * 盤後日行情」（TWSE STOCK_DAY_ALL／TPEx tpex_mainboard_quotes，數字跟日K逐值相同）
 * 組出報價。
 *
 * 呼叫端只有兩個、而且都是「唯一入口」：單檔 getQuote()（quote.ts 的 fetchTwQuote）
 * 與全市場報價表 fetchMarketQuoteMap()（marketQuoteMap.ts）。盤中（輪詢窗內）
 * classifyTwQuoteTradeDate 直接回 live，這裡原樣回傳、**不發任何額外請求**；
 * 盤後日行情只在真的需要時才抓，而且整包快取（休市期間資料不會變）。
 */

export type TwListedExchange = "TWSE" | "TPEx";

/** 盤後日行情整包的快取 TTL：只在非交易時段用到，休市期間資料不變，1 小時已很保守。 */
const DAILY_BARS_TTL_MS = 60 * 60_000;
/** 抓失敗／筆數異常少時只快取 1 分鐘，讓它能自我修復。 */
const DAILY_BARS_DEGRADED_TTL_MS = 60_000;
/** 正常一包是上市約 1,300、上櫃約 1,000 筆；低於這個數字視為抓取殘缺。 */
const DAILY_BARS_MIN_EXPECTED = 300;

function getTwDailyBarMap(exchange: TwListedExchange): Promise<Map<string, TwDailyBar>> {
  return cachedMapWithDegradedShortTtl(
    `tw-daily-bars:${exchange}`,
    DAILY_BARS_TTL_MS,
    DAILY_BARS_DEGRADED_TTL_MS,
    (map) => map.size < DAILY_BARS_MIN_EXPECTED,
    async () => {
      try {
        return exchange === "TWSE" ? await fetchTwseDailyBarsAll() : await fetchTpexDailyBarsAll();
      } catch {
        return new Map<string, TwDailyBar>();
      }
    }
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 用盤後日行情組報價：價＝收盤、昨收＝收盤−官方漲跌、開高低量都取該日（量＝股）。 */
export function quoteFromDailyBar(base: Quote, bar: TwDailyBar): Quote {
  const change = bar.close - bar.prevClose;
  return {
    symbol: base.symbol,
    market: base.market,
    name: base.name,
    price: round2(bar.close),
    change: round2(change),
    changePercent: bar.prevClose ? round2((change / bar.prevClose) * 100) : 0,
    open: round2(bar.open),
    high: round2(bar.high),
    low: round2(bar.low),
    prevClose: round2(bar.prevClose),
    volume: bar.volume,
    currency: base.currency,
    updatedAt: base.updatedAt,
    tradeDate: bar.date,
  };
}

/** 這筆 MIS 報價需要改用盤後日行情嗎？（live／settled-today 不用） */
function needsDailyBar(quote: Quote, now: Date): boolean {
  const state = classifyTwQuoteTradeDate(quote.tradeDate, "TW", now);
  return state !== "live" && state !== "settled-today";
}

/**
 * 盤後日行情如果比 MIS 自己標的交易日還舊（例如盤後資料還沒更新），就不換——
 * 寧可沿用 MIS，也不要拿更舊的一天頂替。日期不合法（未來／週末）時一律換。
 */
function pickDailyBar(quote: Quote, bar: TwDailyBar | undefined, now: Date): TwDailyBar | undefined {
  if (!bar) return undefined;
  const state = classifyTwQuoteTradeDate(quote.tradeDate, "TW", now);
  if (state === "earlier-session" && quote.tradeDate && bar.date < quote.tradeDate) return undefined;
  return bar;
}

/** 單檔：盤中原樣回傳；非交易時段且 MIS 不可信時改用盤後日行情（查不到就維持原值）。 */
export async function reconcileTwListedQuote(
  quote: Quote,
  exchange: TwListedExchange,
  now: Date = new Date()
): Promise<Quote> {
  if (!needsDailyBar(quote, now)) return quote;
  const bar = pickDailyBar(quote, (await getTwDailyBarMap(exchange)).get(quote.symbol), now);
  if (!bar) return quote;
  const rebuilt = quoteFromDailyBar(quote, bar);
  if (exchange !== "TPEx") return rebuilt;
  // 上櫃的 tpex_mainboard_quotes 成交股數只算一般交易（＝MIS 的口徑），個股頁日K
  // （st43）另含盤後定價等，同一天會差幾％（2026-10-02 6488：15,514,000 vs 16,256,000）。
  // 單檔報價跟個股頁日K放在同一頁，量要對得上：同一天的日K有就用日K的量（走圖表
  // 同一個快取 key／模式，個股頁本來就會抓這份）。上市的 STOCK_DAY_ALL 跟 STOCK_DAY
  // 本來就逐值相同，不需要這一步。
  const candle = (await getChart(quote.symbol, "5d", "TW").catch(() => null))?.candles.find((c) => c.time === bar.date);
  return candle ? { ...rebuilt, volume: candle.volume } : rebuilt;
}

/** 全市場報價表：同上規則逐檔套用；只有真的有需要校正的檔才去抓對應交易所的整包。 */
export async function reconcileTwListedQuoteMap(
  map: Map<string, Quote>,
  exchangeOf: (symbol: string) => TwListedExchange,
  now: Date = new Date()
): Promise<Map<string, Quote>> {
  const pending: Array<[string, Quote, TwListedExchange]> = [];
  for (const [symbol, quote] of map) {
    if (needsDailyBar(quote, now)) pending.push([symbol, quote, exchangeOf(symbol)]);
  }
  if (pending.length === 0) return map;
  const exchanges = Array.from(new Set(pending.map((p) => p[2])));
  const bars = new Map(await Promise.all(exchanges.map(async (ex) => [ex, await getTwDailyBarMap(ex)] as const)));
  for (const [symbol, quote, ex] of pending) {
    const bar = pickDailyBar(quote, bars.get(ex)?.get(symbol), now);
    if (bar) map.set(symbol, quoteFromDailyBar(quote, bar));
  }
  return map;
}
