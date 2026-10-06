import type { Market, Quote } from "./types";
import { getQuote } from "./quote";
import { getListedQuotesLive } from "./listedQuoteBatch";
import { ensureTwUniverseWarm, findInUniverse } from "./universe";
import { resolveTwExchange } from "./symbols";
import type { QuoteWithSector } from "@/lib/quotesBatchApi";

/**
 * 關注清單的批次報價：上市只抓清單裡這幾檔（getListedQuotesLive：一個 MIS 請求，跟全市場表
 * 同一套解析與非交易時段校正），抓不到的與其他（上櫃、興櫃、美股）退回單檔 getQuote()——
 * 單檔走既有的快取（過期值同步等重抓，輪詢請求 6 秒、首次載入 1.5 秒，見 swrPolicy.ts），
 * 這裡不新增任何 Redis key。每一檔另外附上官方產業別（跟 /api/quote/[symbol] 一樣）。
 *
 * 2026-10-06：原本上市查全市場報價表，輪詢時表過期要重抓 1000+ 檔（實測 3~10 秒），
 * 等它拖慢回應、不等又回舊表；改成只抓這幾檔，見 listedQuoteBatch.ts。
 */
export async function getQuotesBatch(
  requests: Array<{ market: Market; symbol: string }>
): Promise<Array<QuoteWithSector | null>> {
  const hasTw = requests.some((r) => r.market === "TW");
  if (hasTw) await ensureTwUniverseWarm();

  const listed = requests.filter((r) => r.market === "TW" && servedFromListedBatch(r.symbol)).map((r) => r.symbol);
  const live: Map<string, Quote> = listed.length > 0 ? await getListedQuotesLive(listed) : new Map();

  const withSector = (quote: Quote): QuoteWithSector => {
    const sector = findInUniverse(quote.symbol, quote.market)?.sector;
    return sector ? { ...quote, sector } : quote;
  };
  const results = await Promise.all(
    requests.map(async ({ market, symbol }): Promise<QuoteWithSector | null> => {
      const fromBatch = market === "TW" && servedFromListedBatch(symbol) ? live.get(symbol) : undefined;
      const quote = fromBatch ?? (await getQuote(symbol, market).catch(() => null));
      return quote ? withSector(quote) : null;
    })
  );

  // 單檔抓失敗的 null 只快取 1 秒（quote.ts QUOTE_DEGRADED_TTL_MS）：上游那一刻剛好逾時／節點不健康很常見。
  // 伺服器端的呼叫端（模擬投資組合、AI）沒有前端「1.2 秒後重試」可靠，所以這裡自己對「官方清單裡的股票」
  // 再試一次（只在有失敗時才多等；清單外的代號本來就抓不到，不重試，免得每一輪都白等）。
  const retryIdx = results.flatMap((r, i) => (r === null && findInUniverse(requests[i].symbol, requests[i].market) ? [i] : []));
  if (retryIdx.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, NULL_RETRY_DELAY_MS));
    await Promise.all(
      retryIdx.map(async (i) => {
        const quote = await getQuote(requests[i].symbol, requests[i].market).catch(() => null);
        if (quote) results[i] = withSector(quote);
      })
    );
  }
  return results;
}

/** 略長於單檔報價失敗 null 的快取時間（1 秒），重試才會真的重抓。 */
const NULL_RETRY_DELAY_MS = 1_100;

/**
 * 只有上市（TWSE）走指定代號批次。上櫃刻意走單檔 getQuote()：非交易時段單檔報價會把成交量
 * 對齊個股頁日K（含盤後定價），批次／全市場表的上櫃量只算一般交易（見 twOffHoursQuote.ts），
 * 關注清單要跟個股頁顯示同一個數字。上市兩者本來就逐值相同。
 */
function servedFromListedBatch(symbol: string): boolean {
  return resolveTwExchange(symbol) === "TWSE";
}
