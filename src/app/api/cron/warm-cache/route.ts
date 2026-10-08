import { after, NextRequest, NextResponse } from "next/server";
import {
  getChips,
  getChipsRatiosBatch,
  getEarnings,
  getFundamentals,
  getIndices,
  getLastTechScreenRun,
  getMaterialAnnouncements,
  getMultiSignalStocks,
  getTaifexNightFutures,
  getTechnicalScreen,
  searchStocks,
} from "@/lib/data";
import { getMarketHistory } from "@/lib/data/marketHistory";
import { getConceptScreen } from "@/lib/data/conceptScreen";
import { getDailyBrief } from "@/lib/ai/brief";
import { getActionBrief } from "@/lib/ai/actionBrief";
import { getNewsFeed } from "@/lib/ai/newsfeed";
import { runLearningUpdate } from "@/lib/ai/learning/learningStore";
import { runSimPortfolio } from "@/lib/simPortfolio/run";
import { getMarketStatus } from "@/lib/marketStatus";

// Triggered every few minutes by an external scheduler (see
// .github/workflows/warm-cache.yml — Vercel's own Cron is limited to once a
// day on the Hobby plan, which is nowhere near frequent enough to keep these
// caches warm) so a real visitor's request almost always reads an
// already-computed result instead of triggering the live computation.
// Optionally protected by CRON_SECRET, same convention as api/cron/daily-brief.
//
// Every cache warmed here now shares one site-wide ~5-minute freshness
// standard (see FUNDAMENTALS_TTL_MS in lib/data/index.ts for the fuller
// reasoning) and this cron itself runs on that same ~5-minute cadence, so
// warming each of them here means a real visitor almost never pays a live
// cold-computation cost even though every one of these now expires quickly:
// - the batched market-quote maps and technical-signal screen (search/
//   highlights/homepage movers)
// - the "整個市場一次回傳" whole-market datasets behind per-symbol
//   fundamentals/chips/earnings/announcements lookups — warmed via one
//   representative TW symbol (2330) each, since the underlying cache key is
//   the whole merged TWSE+TPEx map, not per-symbol
// - the daily brief, action brief, and news feed (all AI-touching)
// 2026-10-04 由 60 拉到 120：回應最晚 RESPOND_DEADLINE_MS 就送出，沒做完的項目交給
// after() 在同一次呼叫裡繼續跑完（SWR 背景重算也是）。等待上游／AI 的牆鐘時間不算
// Active CPU，所以拉長上限不會增加 CPU 用量。
export const maxDuration = 120;

// 2026-10-02 16:22 UTC 那次排程失敗就是 curl 等滿 60 秒逾時（exit 28）——所有項目
// 一起等，最慢那項拖住整個回應，Actions 紀錄裡連哪一項慢都看不到。改成最多等這麼久
// 就先回應（沒完成的標成「仍在背景執行」），其餘交給 after() 繼續。
// 2026-10-04 再由 45 秒降到 25 秒：改用 cron-job.org（免費）觸發預熱，它的請求逾時上限是 30 秒，
// 回應必須在那之前送出，否則每次都被記成失敗；沒做完的項目一樣交給 after() 繼續。
const RESPOND_DEADLINE_MS = 25_000;

// Fundamentals/chips/earnings/announcements are cached as one whole-market
// map per category (see lib/data/index.ts), not per symbol — asking for any
// single real TW symbol's data is enough to warm that entire map for every
// other symbol's lookups too. 2330 is always listed on TWSE, so it's a safe
// constant to warm with regardless of TPEx upstream health.
const WARM_PROBE_SYMBOL = "2330";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  // Each entry degrades independently (logged, not thrown) so one slow/failed
  // upstream — e.g. a TPEx hiccup — never takes the whole warm-up run down
  // with it; real visitors still get correct (just possibly slower) data
  // computed on demand for whichever piece didn't warm successfully.
  // 每一項的實際結果也會回報在 HTTP 回應裡（不只寫進 console）——2026-09-20 查
  // 「AI 問答說沒有台股技術指標清單」這個 bug 時，唯一能拿到的線索就是
  // console.error，而正式站的 serverless log 在排查當下拿不到，只能靠間接量測
  // 反覆猜測是「算出空的」還是「整個拋錯」。把結果直接回在這支 cron 的回應裡，
  // 之後同類問題可以一眼看出是哪一項壞掉、壞在哪裡，不用再猜。
  const outcomes: Record<string, string> = {};
  // 每一項附上耗時（牆鐘時間，非 CPU 時間；各項同時起跑、共用上游與快取，只能當
  // 「誰最慢／誰在重算」的粗估）。讀到快取通常是幾十毫秒，明顯更久代表這次真的重算了。
  const pendingLabels: string[] = [];
  const warm = (label: string, task: Promise<unknown>) => {
    pendingLabels.push(label);
    const startedAt = Date.now();
    const took = () => `${Date.now() - startedAt}ms`;
    return task
      .then((value) => {
        outcomes[label] = `${Array.isArray(value) ? `ok (${value.length} 筆)` : value == null ? "ok (無資料)" : "ok"} ${took()}`;
        return value;
      })
      .catch((err) => {
        outcomes[label] = `失敗（${took()}）：${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
        console.error(`[cron] warm-cache: ${label} warm-up failed:`, err);
      });
  };

  try {
    // 預熱項目分層（2026-10-08 使用者：不重要的資料不用每次都取，這樣才能 5 分鐘一次又不耗盡 Redis 免費額度）：
    //  - fast（每次）：行情表、指數、台指期夜盤——數字盤中每幾十秒就變，TTL 短。
    //  - slow（每 30 分鐘才跑一次，或 ?full=1 強制）：技術篩選、概念篩選、訊號共振、市場歷史、籌碼比例、
    //    快報／新聞（AI）、基本面／籌碼／財報／公告整包——變動慢、重算貴；平常沒人看就讓「過期先回舊資料、
    //    背景更新」（swrPolicy）兜底，不必每 5 分鐘都翻一遍。
    //  - 市場別：台股盤中只更新台股項目、美股盤中只更新美股項目；兩邊都休市時兩邊的 slow 項目照常 30 分鐘一次。
    //  - 永遠執行：學習工作與 AI 模擬組合（自己會判斷時點，沒到時間幾乎不碰 Redis）。
    const full = req.nextUrl.searchParams.get("full") === "1";
    const slowDue = full || new Date().getUTCMinutes() % 30 < 5;
    const twOpen = getMarketStatus("TW") === "open";
    const usOpen = getMarketStatus("US") === "open";
    const twActive = full || twOpen || !usOpen;
    const usActive = full || usOpen || !twOpen;
    type Entry = { label: string; run: () => Promise<unknown>; market?: "TW" | "US"; slow?: boolean };
    const entries: Entry[] = [
      { label: "search TW", market: "TW", run: () => searchStocks({ market: "TW", sortBy: "changePercent", sortDir: "desc" }) },
      { label: "search US", market: "US", run: () => searchStocks({ market: "US", sortBy: "changePercent", sortDir: "desc" }) },
      { label: "multi-signal TW", market: "TW", slow: true, run: () => getMultiSignalStocks("TW") },
      { label: "multi-signal US", market: "US", slow: true, run: () => getMultiSignalStocks("US") },
      // AI 問答「多重技術指標篩選」用的全市場指標快照（成交金額前120/60檔各抓一次3個月K線）——這是這支 cron 裡
      // 最昂貴的一項，正是為什麼要在背景預熱：使用者問「有沒有MACD跟KD都黃金交叉的股票」時直接讀快取。
      { label: "technical screen TW", market: "TW", slow: true, run: () => getTechnicalScreen("TW") },
      { label: "technical screen US", market: "US", slow: true, run: () => getTechnicalScreen("US") },
      // 概念篩選（抗壓性、上漲趨勢…，2026-10-07）：沿用技術篩選同一份母體與 K 線快取（同 key 單飛，不會重抓）。
      { label: "concept screen TW", market: "TW", slow: true, run: () => getConceptScreen() },
      { label: "indices", run: () => getIndices() },
      { label: "taifex night", run: () => getTaifexNightFutures() },
      { label: "market history", slow: true, run: () => getMarketHistory() },
      { label: "chips ratios packs", slow: true, run: () => getChipsRatiosBatch([WARM_PROBE_SYMBOL]).then((m) => m.get(WARM_PROBE_SYMBOL)) },
      { label: "daily brief", slow: true, run: () => getDailyBrief() },
      { label: "action brief", slow: true, run: () => getActionBrief() },
      { label: "news feed", slow: true, run: () => getNewsFeed() },
      { label: "fundamentals", market: "TW", slow: true, run: () => getFundamentals(WARM_PROBE_SYMBOL, "TW") },
      { label: "chips", market: "TW", slow: true, run: () => getChips(WARM_PROBE_SYMBOL, "TW") },
      { label: "earnings", market: "TW", slow: true, run: () => getEarnings(WARM_PROBE_SYMBOL, "TW") },
      { label: "announcements", market: "TW", slow: true, run: () => getMaterialAnnouncements(WARM_PROBE_SYMBOL, "TW") },
      // AI 學習循環的每日工作（評等紀錄算獎勵、更新權重／相似案例／成績看板）：盤中與當天已做完時立刻略過，
      // 實際只有收盤後第一次預熱會跑（一天一次，見 learning/learningStore.ts）。
      { label: "learning (daily)", run: () => runLearningUpdate().then((r) => `${r.status}${r.reason ? `：${r.reason}` : ""}`) },
      // AI 模擬投資組合（lib/simPortfolio）：只在 09:30／13:00／13:35 起的時點、且當天該時點還沒做過才交易（冪等＋鎖），
      // 其餘時間不打 Redis 直接略過。13:35 那次另寫一段 AI 檢討（一天一次 lite 呼叫）。
      { label: "sim portfolio", run: () => runSimPortfolio().then((r) => `${r.status}${r.reason ? `：${r.reason}` : ""}`) },
    ];
    const due = entries.filter((e) => (!e.slow || slowDue) && (e.market !== "TW" || twActive) && (e.market !== "US" || usActive));
    for (const e of entries) if (!due.includes(e)) outcomes[e.label] = "本次略過（非此時段或未到更新時間）";
    const all = Promise.all(due.map((e) => warm(e.label, e.run())));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finishedInTime = await Promise.race([
      all.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), RESPOND_DEADLINE_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!finishedInTime) {
      after(all);
      for (const label of pendingLabels) {
        if (!(label in outcomes)) outcomes[label] = `仍在背景執行（>${RESPOND_DEADLINE_MS / 1000}s）`;
      }
    }
    return NextResponse.json({
      ok: true,
      warmedAt: new Date().toISOString(),
      outcomes,
      // 只有這次請求真的重算過技術指標篩選時才會有內容（讀到快取就不會重算，
      // 這個欄位會是空的）——見 getLastTechScreenRun 的說明。
      techScreenRun: getLastTechScreenRun(),
    });
  } catch (err) {
    // Same philosophy as the daily-brief cron: a failed warm-up isn't an
    // outage, real visitors still get correct (just possibly slower) data
    // computed on demand — report it so it's visible in the scheduler's
    // run log, don't let it look like an unhandled crash.
    console.error("[cron] warm-cache failed:", err);
    return NextResponse.json({ ok: false, error: "預熱失敗" }, { status: 503 });
  }
}
