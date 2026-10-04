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
import { getDailyBrief } from "@/lib/ai/brief";
import { getActionBrief } from "@/lib/ai/actionBrief";
import { getNewsFeed } from "@/lib/ai/newsfeed";

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
const RESPOND_DEADLINE_MS = 45_000;

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
    const all = Promise.all([
      // 2026-09-22 地毯式審計抓到：這4項原本沒包 warm()，任何一項拋錯會讓整個
      // Promise.all直接中止、回應只剩籠統的「預熱失敗」503，跟這支路由自己
      // 在上面說明裡宣稱的「每一項獨立降級、結果都要能回報出來」設計互相矛盾。
      // 補上跟其他項目一致的處理方式。
      warm("search TW", searchStocks({ market: "TW", sortBy: "changePercent", sortDir: "desc" })),
      warm("search US", searchStocks({ market: "US", sortBy: "changePercent", sortDir: "desc" })),
      warm("multi-signal TW", getMultiSignalStocks("TW")),
      warm("multi-signal US", getMultiSignalStocks("US")),
      // AI 問答「多重技術指標篩選」用的全市場指標快照（成交金額前120/60檔各抓
      // 一次3個月K線）——這是這支 cron 裡最昂貴的一項，正是為什麼要在背景預熱：
      // 真正的使用者問「有沒有MACD跟KD都黃金交叉的股票」時就直接讀快取，不用
      // 現場等一百多次K線抓取。用 warm() 包起來單獨降級，上游不穩時不會拖垮
      // 其他預熱項目。
      warm("technical screen TW", getTechnicalScreen("TW")),
      warm("technical screen US", getTechnicalScreen("US")),
      warm("indices", getIndices()),
      // 2026-10-04 補上：首頁大盤區塊的台指期夜盤、AI 快報／建議／問答共用的市場
      // 歷史包、列表籌碼比例欄位用的三份全市場整包（融資融券／外資持股／集保大戶，
      // 用一檔代表股就會整包預熱）。台股／美股全市場報價表已由上面的 search TW/US
      // 預熱（searchStocks 底下就是 getMarketQuoteMap）。這些資料都已開「過期先回
      // 舊資料、背景更新」（lib/data/swrPolicy.ts）：讀到過期值時這支路由會先拿到舊值，
      // 重算在 after() 裡跑完（maxDuration 涵蓋），所以一樣有預熱效果。
      warm("taifex night", getTaifexNightFutures()),
      warm("market history", getMarketHistory()),
      warm("chips ratios packs", getChipsRatiosBatch([WARM_PROBE_SYMBOL]).then((m) => m.get(WARM_PROBE_SYMBOL))),
      warm("daily brief", getDailyBrief()),
      warm("action brief", getActionBrief()),
      warm("news feed", getNewsFeed()),
      warm("fundamentals", getFundamentals(WARM_PROBE_SYMBOL, "TW")),
      warm("chips", getChips(WARM_PROBE_SYMBOL, "TW")),
      warm("earnings", getEarnings(WARM_PROBE_SYMBOL, "TW")),
      warm("announcements", getMaterialAnnouncements(WARM_PROBE_SYMBOL, "TW")),
    ]);
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
