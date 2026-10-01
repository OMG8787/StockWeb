import { cached } from "./cache";
import { cachedWithDegradedNullTtl } from "./degradedCache";
import type { Market, Quote } from "./types";
import { fetchTwseQuote } from "./twse";
import { fetchTpexQuote } from "./tpex";
import { fetchEmergingQuote } from "./emerging";
import { fetchUsQuote } from "./us";
import { fetchYahooTwMarketDepth, type MarketDepth } from "./yahooTwMarketDepth";
import { isTwQuoteWindow } from "@/lib/pollingSchedule";
import { detectMarket, normalizeSymbol, resolveTwExchange } from "./symbols";
import { ensureTwUniverseWarm } from "./universe";

export const QUOTE_TTL_MS = 20_000;
/**
 * 台股 08:30~14:30（股市運作期間）的報價快取 TTL。前端在這段時間改成每 1 分鐘
 * 輪詢一次（見 lib/pollingSchedule.ts，2026-09-20 從10秒調整成1分鐘），這裡跟著
 * 對齊成 60 秒——沒必要比前端輪詢間隔還短，快取命中率才會高，白白重抓的次數
 * 才會降到最低。這段時間以外前端根本不輪詢，所以沿用原本的 20 秒即可。
 */
const TW_LIVE_QUOTE_TTL_MS = 60_000;

/** 台股盤中 1 分鐘、其餘情況（含所有美股報價）維持原本的 20 秒。 */
export function quoteTtlMs(market: Market): number {
  return market === "TW" && isTwQuoteWindow() ? TW_LIVE_QUOTE_TTL_MS : QUOTE_TTL_MS;
}

/**
 * 興櫃股票查不到所屬板別時的最後手段（見 fetchTwQuote/fetchTwChart 的
 * 「先試 TWSE 再試 TPEx」設計）：興櫃排在最後一個試，因為它的股票數量最少
 * （約 360 檔 vs 上市 1000+／上櫃 900+），先試前兩個對絕大多數代號來說才是
 * 最短路徑。真正已知在 universe 裡的興櫃股票根本不會走到這條路。
 */
async function fetchTwQuote(symbol: string): Promise<Quote> {
  const exchange = resolveTwExchange(symbol);
  if (exchange === "TPEx") return fetchTpexQuote(symbol);
  if (exchange === "Emerging") return fetchEmergingQuote(symbol);
  if (exchange === "TWSE") return fetchTwseQuote(symbol);
  try {
    return await fetchTwseQuote(symbol);
  } catch (err) {
    try {
      return await fetchTpexQuote(symbol);
    } catch {
      try {
        return await fetchEmergingQuote(symbol);
      } catch {
        throw err;
      }
    }
  }
}

/**
 * Returns null (never a fabricated value) when the live source can't be
 * reached — stock data must be accurate, so an unavailable quote is shown
 * as unavailable rather than filled in with a guess.
 */
export async function getQuote(symbolInput: string, marketHint?: Market): Promise<Quote | null> {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  // findInUniverse()（universe.ts）讀的是一個模組層級的同步快照，warm之前
  // 只是一份很小的內建SEED清單——2026-09-22 實測踩到的真實bug：/api/quote/
  // [symbol] 查完報價後想附加真實sector，因為沒有先warm，SEED以外的股票
  // 悄悄查不到、退回錯誤的預設值。這裡在唯一的單檔報價入口統一warm一次，
  // 任何呼叫getQuote()之後才用findInUniverse()查這檔股票資料的地方都能
  // 直接受益，不用自己再操心這個前置條件（見 ensureTwUniverseWarm() 的
  // 完整說明）。
  if (market === "TW") await ensureTwUniverseWarm();
  // 抓失敗的 null 只快取 QUOTE_DEGRADED_TTL_MS——2026-10-01 Opus 正式站複查抓到：原本用一般
  // cached()，上游偶發一次失敗（逾時／被斷線）的 null 會被當正常結果寫進記憶體＋共用 Redis
  // 存活整個 TTL（盤中 60 秒），關注清單前端 1.2 秒後的重試打到的就是這份 null，該檔必定顯示
  // 「資料暫缺」（例如興櫃 6610／7893、上櫃 8069 輪流中招）。跟 /api/indices 漏抓 TAIEX 同一類。
  // 不在官方股票清單裡的台股代號（打錯／爬蟲亂打 /stock/xxx）失敗是常態不是偶發，null 照舊
  // 快取完整 TTL，免得每秒都對三個交易所各試一次。
  const ttl = quoteTtlMs(market);
  const degradedTtl = market === "TW" && !resolveTwExchange(symbol) ? ttl : QUOTE_DEGRADED_TTL_MS;
  return cachedWithDegradedNullTtl(`quote:${market}:${symbol}`, ttl, degradedTtl, async () => {
    try {
      return market === "TW" ? await fetchTwQuote(symbol) : await fetchUsQuote(symbol);
    } catch {
      return null;
    }
  });
}

/** 單檔報價抓失敗時 null 的快取時間：要短於關注清單前端的重試間隔（1.2 秒，見
 *  WatchlistSection），重試才會真的重抓；同時仍擋住同一瞬間大量請求重複打上游。 */
const QUOTE_DEGRADED_TTL_MS = 1_000;

// A single call here is a full ~370KB HTML page fetch (see
// yahooTwMarketDepth.ts) — genuinely heavier than a normal quote request, so
// this gets a longer TTL than QUOTE_TTL_MS's 20s to avoid re-paying that
// cost on every quick re-render of a stock page someone is actively
// watching. 60s still means "內外盤" catches up within a minute of a real
// swing in buy/sell-side pressure, which is what this figure is for.
const MARKET_DEPTH_TTL_MS = 60_000;

/**
 * TW only（內外盤）— 見 yahooTwMarketDepth.ts 的完整說明：這份資料只有
 * Yahoo 台灣在地化網頁有，且只能整頁抓取，所以只適合這種「使用者正在看
 * 這一檔股票」的單次查詢，故意沒有比照 getChips() 做成「整個市場一次回傳
 * 再查表」的批次模式（那份資料源本身就不支援批次查詢）。抓不到時回傳
 * null，不是抓取失敗就丟錯，個股頁面顯示「資料暫缺」即可。
 */
export async function getMarketDepth(symbolInput: string, marketHint?: Market): Promise<MarketDepth | null> {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  if (market !== "TW") return null;
  return cached(`market-depth:${symbol}`, MARKET_DEPTH_TTL_MS, () =>
    fetchYahooTwMarketDepth(symbol, resolveTwExchange(symbol))
  );
}
