import type { Market, Quote } from "./types";
import { getQuote } from "./quote";
import { getMarketQuoteMap } from "./marketQuoteMap";
import { ensureTwUniverseWarm, findInUniverse } from "./universe";
import { resolveTwExchange } from "./symbols";
import type { QuoteWithSector } from "@/lib/quotesBatchApi";

/**
 * 全市場報價表最多等這麼久；冷快取時寧可退回單檔報價（各自有快取），也不要讓整批卡在
 * 全市場抓取上。暖快取（焦點排行／預熱排程早就算好）時是記憶體查表，幾乎不花時間。
 */
const MARKET_MAP_WAIT_MS = 2_500;

/**
 * 關注清單的批次報價：上市／上櫃先查已快取的全市場報價表（getMarketQuoteMap，跟焦點排行
 * 同一份、同一套非交易時段校正），查不到的（興櫃、美股、不在表裡或表還沒好）才退回
 * 單檔 getQuote()——兩者都走既有的快取，這裡不新增任何快取 key，也不改它們的快取模式。
 * 每一檔另外附上官方產業別（跟 /api/quote/[symbol] 一樣）。
 */
export async function getQuotesBatch(
  requests: Array<{ market: Market; symbol: string }>
): Promise<Array<QuoteWithSector | null>> {
  const hasTw = requests.some((r) => r.market === "TW");
  if (hasTw) await ensureTwUniverseWarm();

  const listed = requests.some((r) => r.market === "TW" && isListed(r.symbol));
  const twMap: Map<string, Quote> | null = listed
    ? await Promise.race([
        getMarketQuoteMap("TW").catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), MARKET_MAP_WAIT_MS)),
      ])
    : null;

  return Promise.all(
    requests.map(async ({ market, symbol }) => {
      const fromMap = market === "TW" && isListed(symbol) ? twMap?.get(symbol) : undefined;
      const quote = fromMap ?? (await getQuote(symbol, market).catch(() => null));
      if (!quote) return null;
      const sector = findInUniverse(quote.symbol, quote.market)?.sector;
      return sector ? { ...quote, sector } : quote;
    })
  );
}

function isListed(symbol: string): boolean {
  const exchange = resolveTwExchange(symbol);
  return exchange === "TWSE" || exchange === "TPEx";
}
