import { peekCached, writeCached } from "./cache";
import { cachedWithDegradedNullTtl } from "./degradedCache";
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
 * 抓不到某一檔指數時，那個 `null` 只快取這麼短的時間（成功時才給
 * `quoteTtlMs()` 的正常 TTL）。見 `cachedWithDegradedNullTtl()` 的完整說明：
 * 這是 2026-09-21 追查「`/api/indices` 間歇性只回 4 筆、缺 TAIEX」時找到的
 * **放大器**——上游掉一次連線，全站所有訪客最長 60 秒都看不到大盤指數。
 *
 * 3 秒的用意不是「讓前端那一次輪詢馬上補回來」（前端輪詢本來就是 TW 60 秒 /
 * US 20 秒一次，見 `pollingSchedule.ts`），而是**不要讓一次失敗透過共用的
 * Redis 傳染給其他人**：使用者真正會看到「大盤指數目前無法取得」的時機，是
 * 首頁 SSR（`app/page.tsx`）那一次 `getIndices()` 剛好抓不到 TAIEX
 * （`LiveIndices` 只在初始資料為空時顯示那句話，之後失敗的輪詢不會把已經有的
 * 卡片清掉）。舊行為下這個 null 會被所有後續的 SSR、AI 問答、每日快報共用整整
 * 60 秒；現在 3 秒後的下一個請求就會重新抓一次。3 秒也短到足以自我修復、又不
 * 至於在上游真的掛掉時變成每個請求都去打一次（每 3 秒最多 2 次嘗試，遠低於
 * 本站全市場批次報價本身的量）。
 */
const INDEX_DEGRADED_TTL_MS = 3_000;
/**
 * 同一檔指數在放棄（回傳 null）之前額外重試幾次。
 *
 * 為什麼需要重試：見下方 getIndices() 的根因說明。上游 `mis.twse.com.tw` 被
 * 併發量惹到時的反應是「TLS 連上之後直接關掉連線、不回任何內容」（Node 端表現
 * 為 `TypeError: fetch failed (other side closed)`，通常在幾十毫秒內就失敗）
 * 或是整個卡住直到 4 秒逾時。前者重試幾乎是零成本，後者最壞會讓這一檔多花
 * 約 4 秒——但代價相對於「整個站 60 秒沒有大盤指數」明顯划算，而且只發生在
 * 本來就會壞掉的那條路上。
 */
const INDEX_FETCH_RETRIES = 1;
/** 重試前先讓一下，等本站自己造成的那一波併發（見下方說明）過去。 */
const INDEX_RETRY_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadIndex(def: (typeof INDEX_DEFS)[number]): Promise<IndexQuote | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const q =
        def.market === "TW" && def.misCode ? await fetchTwseQuote(def.misCode) : await fetchUsQuote(def.symbol);
      return {
        symbol: def.symbol,
        name: def.name,
        market: def.market,
        price: q.price,
        change: q.change,
        changePercent: q.changePercent,
      };
    } catch (err) {
      if (attempt >= INDEX_FETCH_RETRIES) {
        // 刻意留下紀錄：這個 bug 之所以被掛著好幾天查不出根因，就是因為原本
        // 這裡是一個什麼都不做的 `catch {}`，正式站 log 裡完全沒有任何證據可
        // 以判斷是逾時、連線被關掉、還是上游回了空資料。
        console.warn(
          `[indices] ${def.symbol} 連續 ${attempt + 1} 次抓取失敗，這次回應不含這一檔：`,
          err instanceof Error ? err.message : err
        );
        return null;
      }
      await sleep(INDEX_RETRY_DELAY_MS);
    }
  }
}

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
 *
 * ---
 * 2026-09-21：「`/api/indices` 間歇性只回 4 筆、獨缺 TAIEX」的根因調查結果。
 *
 * 為什麼永遠只缺 TAIEX：另外 4 檔（道瓊/S&P 500/那斯達克/費半）走的是 Yahoo
 * （`./us.ts`），跟 TAIEX 的 `mis.twse.com.tw` 完全是不同主機，所以 MIS 出狀況
 * 時只有 TAIEX 這一檔會消失。
 *
 * 上游到底怎麼壞的（實測確認）：對 `mis.twse.com.tw` 連續發出大量併發請求後，
 * 它**不會**回 HTTP 429 或任何錯誤 JSON，而是接受 TLS 交握之後直接關掉連線、
 * 完全不回內容（`curl` 顯示 "Empty reply from server"、Node 端是
 * `TypeError: fetch failed (other side closed)`），或者乾脆卡住直到我們自己的
 * 4 秒逾時。實測 150 個併發請求打 t00 時有 39% 失敗（44 次逾時、14 次連線被
 * 關掉），而且那之後整個來源 IP 被靜默封鎖數分鐘，連單一請求都拿不到回應。
 *
 * 而那個併發量是**本站自己造成的**：`fetchTwseQuotesBatch()` 會把約 1100 檔
 * 上市股票切成 22 塊、用無上限的 `Promise.all` 同時打同一台主機，
 * `fetchTpexQuotesBatch()` 再對同一台主機同時打約 18 塊，合計一次全市場報價
 * 更新就是約 40 個同時連線。更關鍵的是 TAIEX 這個「單檔 t00 查詢」在多數情況
 * 下是**跟那一波併發放在同一個 `Promise.all` 裡**發出的（見 `app/page.tsx`、
 * `lib/ai/brief.ts`、`lib/ai/actionBrief.ts`、`lib/ai/ask.ts`、
 * `api/cron/warm-cache`），所以它本來就是最容易被上游選中丟掉的那一個。
 *
 * 然後是放大器：舊版把失敗的 `null` 用 `cached()` 當成正常結果寫進記憶體
 * **和共用的 Redis**，存活整個 TTL（盤中 60 秒）。於是「上游掉一次連線」被放大
 * 成「全站所有訪客最長 60 秒看不到大盤指數」，而且完全沒有自我修復機會——這就
 * 是為什麼當下直接打上游 t00 明明有資料，本站卻還在說取不到。
 *
 * 這次的修法分三層：
 * 1. 逐檔重試一次（`INDEX_FETCH_RETRIES`）——上游這種掉連線多半是瞬時的。
 * 2. 失敗只快取 3 秒（`INDEX_DEGRADED_TTL_MS`），不再用正常 TTL 快取失敗。
 * 3. 把上面說的那 40 個同時連線收斂掉（見 `twse.ts`/`tpex.ts` 的
 *    `MIS_BATCH_CONCURRENCY`），從源頭降低上游被惹到的機率。
 *
 * 誠實標註調查邊界：第 2 層（放大器）是純粹的程式邏輯缺陷，讀程式碼就能確認，
 * 修掉它是根治。第 1、3 層針對的是上游的丟連線行為——那個行為本身是實測確認
 * 的，但實測是從開發機的 IP 打出去的，Vercel 出口 IP 究竟在幾個同時連線時
 * 開始被丟掉，沒有辦法從外部量到（正式站 log 從現在起會留下
 * `[indices] …抓取失敗` 這行，下次再發生時就能直接看到失敗原因與頻率）。
 * 所以第 1、3 層要算「有實測依據、但未在正式站環境直接量到門檻」的加固。
 */
export async function getIndices(): Promise<IndexQuote[]> {
  const results = await Promise.all(
    INDEX_DEFS.map((def) =>
      // 逐檔用自己市場的 TTL：台股指數盤中 60 秒、美股指數維持 20 秒，
      // 不會因為放在同一個 getIndices() 就把台股規則套到美股指數上。
      cachedWithDegradedNullTtl<IndexQuote>(
        `index:${def.symbol}`,
        quoteTtlMs(def.market),
        INDEX_DEGRADED_TTL_MS,
        () => loadIndex(def)
      )
    )
  );
  return results.filter((r): r is IndexQuote => r !== null);
}

/** 最後一次成功抓到的夜盤收盤快照，獨立於上面正常 20 秒 TTL 的即時快取之外，
 *  存活時間要蓋過白天整段「上游把盤面清空」的空窗（見下方函式說明）。24 小時
 *  保守抓：即使使用者連續好幾天沒開網站，重新打開時「上次收盤」也比什麼都
 *  沒有好，且下一次夜盤一開盤，這個快照就會被真正即時的資料蓋過去，不會有
 *  「用太舊的快照騙過使用者」的風險。 */
const TAIFEX_LAST_KNOWN_TTL_MS = 24 * 60 * 60_000;
const TAIFEX_LAST_KNOWN_KEY = "taifex:tx-night:last-known";

/**
 * 台指期（TX，大台指）夜盤近月合約報價——見 lib/data/taifex.ts 開頭的完整資料源
 * 研究說明。跟 getIndices() 分開一個函式（而不是塞進 INDEX_DEFS），是因為這個
 * 資料需要額外的 status/asOf 欄位才能誠實呈現「交易中」跟「已收盤」的差異，
 * IndexQuote 型別沒有這兩個欄位。
 *
 * 2026-09-21 第一輪：Opus 規則二實測抓到跟 getIndices() 一模一樣的雷——原本用
 * `cached()` 把抓取失敗的 `null` 當成正常結果快取整個 `QUOTE_TTL_MS`。改成跟
 * getIndices() 同一套：抓取失敗先重試一次，失敗的 null 只快取
 * `INDEX_DEGRADED_TTL_MS`（3秒），並留下失敗訊息方便排查。
 *
 * 2026-09-21 第二輪（複查後發現這樣還不夠）：Opus 直接打上游確認，白天約
 * 05:00~15:00 這段非夜盤時段，`mis.taifex.com.tw` 會把整個夜盤盤面的
 * `CLastPrice` 等欄位清空回傳空字串——**這不是失敗，是上游本來的設計**，
 * `fetchTaifexNightFutures()` 因此「正常」回傳 null，不會拋例外，上面第一輪
 * 加的重試/降級TTL完全對不到這個情況，所以白天這約10小時卡片必然顯示
 * 「資料暫缺」。單純顯示暫缺並沒有騙人（誠實反映「這個端點現在真的沒有
 * 資料」），但比之前偶爾能看到的「最近一次夜盤收盤，資料時間X」體驗差一截。
 *
 * 修法：另外用一個長效 key（見上面 TAIFEX_LAST_KNOWN_KEY）記住「最後一次真正
 * 成功抓到的收盤快照」，只在抓取真的成功時才更新它；即時抓取回傳 null 時
 * （不管是白天的正常清空、還是真的暫時性失敗），改讀這個快照當退路，並且
 * **強制把 status 覆寫成 "closed"**——不能直接沿用快照裡舊的 status，也不能
 * 相信這次失敗回應裡的 status 欄位：Opus 提醒過白天那些清空的列，`Status`
 * 欄位是空字串，`classifyStatus("")` 會被誤判成 "trading"，如果照抄就會變成
 * 「顯示交易中卻沒有價格」的錯誤畫面，比純顯示暫缺更誤導人。只有真的從來沒
 * 成功抓到過一次（例如網站剛部署的第一刻）才會落到最後的 null。
 */
export async function getTaifexNightFutures(): Promise<TaifexFuturesQuote | null> {
  const live = await cachedWithDegradedNullTtl<TaifexFuturesQuote>(
    "taifex:tx-night",
    QUOTE_TTL_MS,
    INDEX_DEGRADED_TTL_MS,
    async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await fetchTaifexNightFutures();
        } catch (err) {
          if (attempt >= INDEX_FETCH_RETRIES) {
            console.warn(
              `[taifex-night] 連續 ${attempt + 1} 次抓取失敗，改讀最後一次成功快照：`,
              err instanceof Error ? err.message : err
            );
            return null;
          }
          await sleep(INDEX_RETRY_DELAY_MS);
        }
      }
    }
  );

  if (live) {
    // 不用 await 卡住回應：這只是把「這次成功結果」順手存一份長效備份，不影響
    // 這次要回給使用者的資料，失敗也無所謂（下次成功時還會再存一次）。
    void writeCached(TAIFEX_LAST_KNOWN_KEY, live, TAIFEX_LAST_KNOWN_TTL_MS).catch(() => undefined);
    return live;
  }

  const lastKnown = await peekCached<TaifexFuturesQuote>(TAIFEX_LAST_KNOWN_KEY);
  if (!lastKnown) return null;
  return { ...lastKnown, status: "closed" };
}
