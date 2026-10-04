import { cachedMapWithDegradedShortTtl } from "./degradedCache";
import { LIVE_CACHE_TTL_MS } from "@/lib/pollingSchedule";
import type { Market, Quote } from "./types";
import { fetchTwseQuote, fetchTwseQuotesBatch } from "./twse";
import { fetchTpexQuote, fetchTpexQuotesBatch } from "./tpex";
import { fetchUsQuote, fetchUsQuotesBatch } from "./us";
import { isTwQuoteWindow } from "@/lib/pollingSchedule";
import { maybeRecordDailyVolumeSnapshot } from "./volumeHistory";
import { universeFor } from "./symbols";
import { liveSwrOptions } from "./swrPolicy";
import { reconcileTwListedQuoteMap } from "./twOffHoursQuote";

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
  // 非交易時段 MIS 可能回「重置／測試」狀態——上市櫃統一在這裡改用盤後日行情校正
  // （盤中原樣回傳、不發額外請求），見 twOffHoursQuote.ts。放在 volume 快照之前，
  // 避免把測試資料的成交量記成當日量。
  if (market === "TW") {
    const tpexSymbols = new Set(pool.filter((e) => e.exchange === "TPEx").map((e) => e.symbol));
    await reconcileTwListedQuoteMap(map, (symbol) => (tpexSymbols.has(symbol) ? "TPEx" : "TWSE"));
  }

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
// 2026-10-04 曾評估改回 55 秒省 Active CPU（這張表是 CPU 大戶之一），但使用者決定
// 「每 30 秒更新」優先於省 CPU（Hobby 方案超量不會產生費用），維持 25 秒。
const TW_LIVE_MARKET_MAP_TTL_MS = LIVE_CACHE_TTL_MS;

// 抓失敗/部分降級時只快取這麼短——見下方 getMarketQuoteMap() 的完整說明。
// 3 秒跟 marketIndices.ts 的 INDEX_DEGRADED_TTL_MS 同一個量級：短到能自我
// 修復，又不至於在上游真的降級時讓每個請求都各自重打一次全市場批次抓取。
const MARKET_MAP_DEGRADED_TTL_MS = 3_000;
// 回傳筆數低於「這個市場預期規模」的這個比例，就視為降級。50% 是刻意寬鬆的
// 門檻——真正的批次抓取部分失敗，觀察到的是暴跌到個位數/低兩位數百分比
// （例如實測過 0筆／50筆，對 universe 規模約 2000 筆），不是「差一點點」；
// 訂在一半是為了確保絕對不會誤傷「今天剛好有幾十檔連不到」這種正常小幅波動。
const MARKET_MAP_DEGRADED_RATIO = 0.5;

/**
 * 2026-09-21 追查「台股候選池（searchStocks 用成交金額排序）間歇性大幅縮水」
 * （曾實測到同一個查詢在不同時刻分別回傳過 0筆／50筆／1535筆）時發現：這裡
 * 原本用普通 `cachedMap()`，代表 `fetchMarketQuoteMap()` 萬一某次只成功抓到
 * 一小部分（例如上游批次抓取部分失敗），這份殘缺的報價表會被當成正常結果
 * 整個快取滿 TTL（盤中60秒／盤後120秒）——跟同一天稍早修的 `/api/indices`
 * 漏抓TAIEX是同一種「失敗結果被當正常快取放大」的模式。改用
 * `cachedMapWithDegradedShortTtl()`：拿到的筆數明顯低於這個市場的 universe
 * 規模時，只快取 `MARKET_MAP_DEGRADED_TTL_MS`（3秒），讓系統能盡快自我修復，
 * 不用乾等一整個正常TTL；筆數正常時維持原本的TTL不變。
 */
export async function getMarketQuoteMap(market: Market): Promise<Map<string, Quote>> {
  const ttl = market === "TW" && isTwQuoteWindow() ? TW_LIVE_MARKET_MAP_TTL_MS : MARKET_MAP_TTL_MS;
  const pool = await universeFor(market);
  const expectedMin = pool.length * MARKET_MAP_DEGRADED_RATIO;
  return cachedMapWithDegradedShortTtl(
    `market-quotes:${market}`,
    ttl,
    MARKET_MAP_DEGRADED_TTL_MS,
    (map) => map.size < expectedMin,
    () => fetchMarketQuoteMap(market),
    // 全站最貴的上游呼叫：過期時先回舊表、背景重抓（殘缺的表不會蓋掉舊的完整表），
    // 見 swrPolicy.ts。
    liveSwrOptions(market)
  );
}
