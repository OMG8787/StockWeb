import { cached } from "./cache";
import type { IndexQuote, Market, TaifexFuturesQuote } from "./types";
import { fetchTwseQuote } from "./twse";
import { fetchUsQuote } from "./us";
import { fetchTaifexNightFutures } from "./taifex";
import { QUOTE_TTL_MS, quoteTtlMs } from "./quote";

// "美股四大指數" as this site's Taiwanese audience means it: 道瓊/S&P 500/
// 那斯達克 plus 費城半導體指數（SOX）— the semiconductor-heavy Philadelphia
// index is the conventional 4th "major" one watched alongside the other
// three specifically in Taiwan financial media, given how closely TW's own
// market (TSMC and the broader chip supply chain) tracks it; it is not one
// of the "big 3" in a purely US context, which is why it was missing here.
const INDEX_DEFS: Array<{ symbol: string; name: string; market: Market; misCode?: string }> = [
  { symbol: "TAIEX", name: "台股加權指數", market: "TW", misCode: "t00" },
  { symbol: "^DJI", name: "道瓊工業指數", market: "US" },
  { symbol: "^GSPC", name: "S&P 500", market: "US" },
  { symbol: "^IXIC", name: "那斯達克指數", market: "US" },
  { symbol: "^SOX", name: "費城半導體指數", market: "US" },
];

/**
 * Only includes indices that were actually fetched successfully — an
 * index that failed to load is simply omitted rather than shown with a
 * substitute value.
 *
 * Each index is cached under its own key rather than one "indices" key for
 * the whole array: with a single shared key, one bad moment where all four
 * upstream calls happened to fail at once cached an *empty* array for the
 * full TTL, blanking the homepage's index cards for 20s even if upstream
 * had already recovered a moment later. Per-index keys mean a transient
 * failure only withholds that one index for its own TTL, and doesn't touch
 * whatever the others most recently succeeded with.
 */
export async function getIndices(): Promise<IndexQuote[]> {
  const results = await Promise.all(
    INDEX_DEFS.map((def) =>
      // 逐檔用自己市場的 TTL：台股指數盤中 10 秒、美股指數維持 20 秒，
      // 不會因為放在同一個 getIndices() 就把台股規則套到美股指數上。
      cached<IndexQuote | null>(`index:${def.symbol}`, quoteTtlMs(def.market), async () => {
        try {
          const q =
            def.market === "TW" && def.misCode ? await fetchTwseQuote(def.misCode) : await fetchUsQuote(def.symbol);
          return { symbol: def.symbol, name: def.name, market: def.market, price: q.price, change: q.change, changePercent: q.changePercent };
        } catch {
          return null;
        }
      })
    )
  );
  return results.filter((r): r is IndexQuote => r !== null);
}

/**
 * 台指期（TX，大台指）夜盤近月合約報價——見 lib/data/taifex.ts 開頭的完整資料源
 * 研究說明。跟 getIndices() 分開一個函式（而不是塞進 INDEX_DEFS），是因為這個
 * 資料需要額外的 status/asOf 欄位才能誠實呈現「交易中」跟「已收盤」的差異，
 * IndexQuote 型別沒有這兩個欄位。快取沿用跟其他即時報價一樣的 QUOTE_TTL_MS，
 * 抓不到（含近月合約還沒開出成交價）一律回傳 null，不用參考價頂替。
 */
export async function getTaifexNightFutures(): Promise<TaifexFuturesQuote | null> {
  return cached<TaifexFuturesQuote | null>("taifex:tx-night", QUOTE_TTL_MS, async () => {
    try {
      return await fetchTaifexNightFutures();
    } catch {
      return null;
    }
  });
}
