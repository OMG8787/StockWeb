import { cachedMap } from "./cache";
import type { Market, Quote } from "./types";
import { fetchTwseQuote, fetchTwseQuotesBatch } from "./twse";
import { fetchTpexQuote, fetchTpexQuotesBatch } from "./tpex";
import { fetchUsQuote, fetchUsQuotesBatch } from "./us";
import { isTwQuoteWindow } from "@/lib/pollingSchedule";
import { maybeRecordDailyVolumeSnapshot } from "./volumeHistory";
import { universeFor } from "./symbols";

/**
 * All of a market's universe quotes in one batched network call (plus a
 * per-symbol fallback for whatever the batch didn't cover), cached and
 * shared across every caller — search page, both market tabs, homepage
 * movers, highlights boards, and the daily brief all hit the same cached
 * map instead of each re-fetching (or worse, each firing 20+ of their own
 * concurrent per-symbol requests, which is what made list pages show
 * mostly-stale/failed data even when single-stock pages were fetching real
 * quotes fine: TWSE/Yahoo's single-symbol endpoints aren't meant for that
 * many concurrent hits from one caller and tend to time out or get
 * throttled). Symbols that fail both the batch and the per-symbol retry
 * are simply absent from the map — never filled in with a guess.
 */
async function fetchMarketQuoteMap(market: Market): Promise<Map<string, Quote>> {
  const pool = await universeFor(market);
  const map = new Map<string, Quote>();

  if (market === "TW") {
    // Two separate exchanges behind one "TW" batch: each gets its own
    // request and its own try/catch so a TWSE or TPEx outage only costs
    // that exchange's symbols, not the whole TW screen.
    //
    // 注意這兩邊現在都打**同一台**上游主機（`mis.twse.com.tw`，TPEx 報價在
    // 2026-09 從 end-of-day 的 tpex.org.tw 換過來之後就是如此——這段原本寫著
    // 「TPEx 永遠只有一個整市場請求、跟併發無關」已經過時了），而且是並行的，
    // 所以兩邊的分塊併發上限共用同一個常數 `MIS_BATCH_CONCURRENCY`（見
    // twse.ts）。這一次全市場更新對該主機造成的同時連線數，正是
    // `/api/indices` 間歇性漏掉 TAIEX 的根因之一，完整說明見
    // marketIndices.ts 的 getIndices()。
    const twsePool = pool.filter((e) => e.exchange !== "TPEx").map((e) => e.symbol);
    const tpexPool = pool.filter((e) => e.exchange === "TPEx").map((e) => e.symbol);
    const [twseBatch, tpexBatch] = await Promise.all([
      fetchTwseQuotesBatch(twsePool).catch(() => new Map<string, Quote>()),
      fetchTpexQuotesBatch(tpexPool).catch(() => new Map<string, Quote>()),
    ]);
    for (const [symbol, quote] of twseBatch) map.set(symbol, quote);
    for (const [symbol, quote] of tpexBatch) map.set(symbol, quote);
  } else {
    try {
      const batch = await fetchUsQuotesBatch(pool.map((e) => e.symbol));
      for (const [symbol, quote] of batch) map.set(symbol, quote);
    } catch {
      // batch endpoint failed outright; every symbol falls through to the
      // per-symbol attempt below instead
    }
  }

  // Only bother retrying individually when a small number slipped through
  // the batch — if the batch failed wholesale or missed a lot of symbols,
  // firing dozens+ of concurrent single-symbol requests on top of it risks
  // getting the whole site rate-limited by TWSE/Yahoo (breaking unrelated
  // single-stock lookups too), for a screen that only shows a handful of
  // rows anyway. Those symbols are just omitted, same as any other
  // unreachable quote.
  const MAX_SINGLE_RETRIES = 15;
  const missing = pool.filter((e) => !map.has(e.symbol));
  if (missing.length > 0 && missing.length <= MAX_SINGLE_RETRIES) {
    const singles = await Promise.all(
      missing.map(async (entry): Promise<[string, Quote] | null> => {
        try {
          const q =
            market === "TW"
              ? entry.exchange === "TPEx"
                ? await fetchTpexQuote(entry.symbol)
                : await fetchTwseQuote(entry.symbol)
              : await fetchUsQuote(entry.symbol);
          return [entry.symbol, q];
        } catch {
          return null;
        }
      })
    );
    for (const s of singles) {
      if (s) map.set(s[0], s[1]);
    }
  }

  // Fire-and-forget, piggybacked on this same batch fetch rather than a
  // separate schedule or per-symbol call — see volumeHistory.ts for why this
  // is the "compute the whole-market volume trend cheaply" design: it's a
  // small conditional Redis read+write, not an extra upstream request, and
  // it internally no-ops except once per real trading day. Never awaited so
  // it can't add latency to (or, via its own try/catch, ever fail) this
  // already-expensive batch quote fetch.
  void maybeRecordDailyVolumeSnapshot(market, map);

  return map;
}

// Deliberately much longer than QUOTE_TTL_MS (used for a single symbol's
// "live" quote while actively watching its page). This is the whole-universe
// batch fetch behind search/highlights/homepage rankings — by far the most
// expensive upstream call in the app — and a personal browsing tool doesn't
// need second-by-second freshness on a ranking list the way a single quote
// being actively watched does. At 20s, any real visit more than 20s after
// the last one (i.e. essentially every normal visit, since people don't
// click faster than that) missed the cache and paid the full TWSE/Yahoo
// batch-fetch cost — which is what made every highlights/search visit feel
// slow regardless of how fast the code computing on top of it was.
const MARKET_MAP_TTL_MS = 2 * 60_000;

/**
 * 台股 08:30~14:30 期間縮短到 60 秒。首頁「焦點排行」盤中每 10 秒輪詢一次
 * /api/search，若這份全市場快取還是 2 分鐘，畫面上的漲跌幅最久要 2 分鐘才會
 * 換一次數字，跟使用者要的「盤中即時」差太多。
 *
 * 但也**刻意不跟著縮到 10 秒**：這是全站最貴的一次上游呼叫（整個市場的批次
 * 報價），PROGRESS.md 2026-09-11 那次效能事故就是因為這份資料只快取 20 秒，
 * 導致幾乎每一次瀏覽都要現場付整批抓取的成本、全站變慢。60 秒是「盤中數字
 * 會動」跟「不要重演那次變慢」之間的取捨：焦點排行實際最快每分鐘換一次數字，
 * 個股報價/大盤指數/關注清單那些單檔報價則是真正的 10 秒級。
 */
const TW_LIVE_MARKET_MAP_TTL_MS = 60_000;

// cachedMap, not cached: this value is a Map, and the Redis backend stores
// JSON — a Map would come back from a shared-cache hit as an empty object.
export async function getMarketQuoteMap(market: Market): Promise<Map<string, Quote>> {
  const ttl = market === "TW" && isTwQuoteWindow() ? TW_LIVE_MARKET_MAP_TTL_MS : MARKET_MAP_TTL_MS;
  return cachedMap(`market-quotes:${market}`, ttl, () => fetchMarketQuoteMap(market));
}
