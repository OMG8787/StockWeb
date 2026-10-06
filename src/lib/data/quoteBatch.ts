import type { Market, Quote } from "./types";
import { getQuote } from "./quote";
import { getMarketQuoteMap } from "./marketQuoteMap";
import { ensureTwUniverseWarm, findInUniverse } from "./universe";
import { resolveTwExchange } from "./symbols";
import { liveRevalidateWaitMs } from "./swrPolicy";
import type { QuoteWithSector } from "@/lib/quotesBatchApi";

/**
 * 全市場報價表最多等這麼久；冷快取時寧可退回單檔報價（各自有快取），也不要讓整批卡在
 * 全市場抓取上。暖快取（焦點排行／預熱排程早就算好）時是記憶體查表，幾乎不花時間。
 */
const MARKET_MAP_WAIT_MS = 2_500;
/** 輪詢請求（x-live-poll）等全市場表重抓的上限比 SWR 同步等待多留這點餘裕：表自己最多等
 *  liveRevalidateWaitMs() 就會回（新值或舊表），這裡只是不比它先放棄。 */
const MARKET_MAP_POLL_MARGIN_MS = 500;

/**
 * 關注清單的批次報價：上市先查已快取的全市場報價表（getMarketQuoteMap，跟焦點排行
 * 同一份、同一套非交易時段校正），查不到的（上櫃、興櫃、美股、不在表裡或表還沒好）才退回
 * 單檔 getQuote()——兩者都走既有的快取，這裡不新增任何快取 key，也不改它們的快取模式。
 * 每一檔另外附上官方產業別（跟 /api/quote/[symbol] 一樣）。
 */
export async function getQuotesBatch(
  requests: Array<{ market: Market; symbol: string }>
): Promise<Array<QuoteWithSector | null>> {
  const hasTw = requests.some((r) => r.market === "TW");
  if (hasTw) await ensureTwUniverseWarm();

  const anyFromMap = requests.some((r) => r.market === "TW" && servedFromMarketMap(r.symbol));
  const twMap: Map<string, Quote> | null = anyFromMap
    ? await Promise.race([
        getMarketQuoteMap("TW").catch(() => null),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), Math.max(MARKET_MAP_WAIT_MS, liveRevalidateWaitMs() + MARKET_MAP_POLL_MARGIN_MS))
        ),
      ])
    : null;

  return Promise.all(
    requests.map(async ({ market, symbol }) => {
      const fromMap = market === "TW" && servedFromMarketMap(symbol) ? twMap?.get(symbol) : undefined;
      const quote = fromMap ?? (await getQuote(symbol, market).catch(() => null));
      if (!quote) return null;
      const sector = findInUniverse(quote.symbol, quote.market)?.sector;
      return sector ? { ...quote, sector } : quote;
    })
  );
}

/**
 * 只有上市（TWSE）查全市場表。上櫃刻意走單檔 getQuote()：非交易時段單檔報價會把成交量
 * 對齊個股頁日K（含盤後定價），全市場表的上櫃量只算一般交易（見 twOffHoursQuote.ts），
 * 關注清單要跟個股頁顯示同一個數字。上市兩者本來就逐值相同。
 */
function servedFromMarketMap(symbol: string): boolean {
  return resolveTwExchange(symbol) === "TWSE";
}
