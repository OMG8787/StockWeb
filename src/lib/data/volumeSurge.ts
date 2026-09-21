import { mapWithConcurrency } from "./cache";
import type { Market } from "./types";
import { computeStreak } from "@/lib/signals";
import { searchStocks } from "./search";
import { getChart } from "./chart";
import { cachedListWithDegradedEmptyTtl } from "./degradedCache";

export interface VolumeSurgeItem {
  symbol: string;
  market: Market;
  name: string;
  price: number;
  changePercent: number;
  volumeRatio?: number;
  /** 從最新一天往回算的連續上漲/下跌天數，0代表今天走勢跟昨天相反或平盤（不成
   *  立連續），任何長度都會回傳（不像 MomentumItem 的訊號只在達到3天以上才會
   *  出現）——用意是讓 AI 問答能誠實回答「剛漲一天」「連漲兩天」這種低於3天
   *  門檻的問法，而不是因為只看得到 >=3 天的訊號就誤判成沒有資料。 */
  streakDays: number;
  streakDirection: "up" | "down" | null;
}

// 2026-09-20：拉長到 20 分鐘——一樣是要對候選股逐一抓K線的較貴計算，理由同
// MOMENTUM_TTL_MS/TECH_SCREEN_TTL_MS 的說明。
const VOLUME_SURGE_TTL_MS = 20 * 60_000;
// 空結果專用的短 TTL，理由同 TECH_SCREEN_DEGRADED_TTL_MS：這份清單的候選池
// 同樣來自 searchStocks，上游暫時性降級時一樣會算出空清單，一旦被當成正常
// 結果快取 20 分鐘，AI 問「價漲量增、連漲N天」就會在這段期間一律誤答「沒有
// 資料」——正是這個功能當初被使用者回報的那個 bug 的表現方式。
const VOLUME_SURGE_DEGRADED_TTL_MS = 60_000;
// 這裡刻意跟 getMultiSignalStocks 的做法不同：先用完全不用抓K線、成本很低的
// searchStocks({volumeTrends:["buy-leaning"]})（只靠已經有的報價+近期均量快取）
// 掃過「整個台股市場」找出真正符合「今日價漲、且量能明顯高於自己均量」的股票，
// 不是像 momentum 那樣只從「當日漲跌幅最大的前15檔」這個很窄的池子裡挑——這正是
// 使用者實測抓到的真實bug根因：5251、3467 那天很可能都不在全市場當日漲跌幅前15名
// 之內，導致 getMultiSignalStocks 從一開始就不會把它們納入候選，AI 自然「查無資料」。
// 只有篩出「價漲量增」這個語意正確的候選集合之後，才對這個相對小很多的子集合
// （通常一天不會有數百檔同時符合價漲量增）逐一抓K線算連漲天數，把「大範圍篩選」
// 跟「昂貴的逐檔連漲天數計算」拆成兩個成本層級不同的步驟。
const VOLUME_SURGE_CANDIDATE_LIMIT = 60;
const VOLUME_SURGE_CHART_CONCURRENCY = 25;

/**
 * 真正的「今日價漲量增」全市場篩選（見上方 VolumeSurgeItem 註解的根因說明）：
 * 用 searchStocks 的 volumeTrends 篩選先掃出全市場符合「價漲量增」的股票，再對
 * 這個子集合逐檔算出連續上漲/下跌天數，讓 AI 問答可以誠實地依使用者指定的天數
 * （剛漲一天、連漲兩天、連漲三天...）從真實資料裡篩選回答，而不是只能回答固定
 * 一種天數門檻或直接說沒有資料。
 */
export async function getVolumeSurgeStocks(market: Market): Promise<VolumeSurgeItem[]> {
  return cachedListWithDegradedEmptyTtl(
    `volume-surge:${market}:v1`,
    VOLUME_SURGE_TTL_MS,
    VOLUME_SURGE_DEGRADED_TTL_MS,
    async () => {
      const pool = await searchStocks({ market, volumeTrends: ["buy-leaning"], sortBy: "turnover", sortDir: "desc" });
      const candidates = pool.slice(0, VOLUME_SURGE_CANDIDATE_LIMIT);

      const results = await mapWithConcurrency(
        candidates,
        VOLUME_SURGE_CHART_CONCURRENCY,
        async (item): Promise<VolumeSurgeItem | null> => {
          // 逐檔容錯，理由同 getTechnicalScreen 裡的說明：一檔出錯不該讓整份
          // 「價漲量增」清單變成空的，那正是使用者當初回報的「明明有股票卻被
          // 誤答沒有資料」的表現方式。
          try {
            const chart = await getChart(item.symbol, "1m", item.market);
            if (!chart) return null;
            const streak = computeStreak(chart.candles);
            return {
              symbol: item.symbol,
              market: item.market,
              name: item.name,
              price: item.price,
              changePercent: item.changePercent,
              volumeRatio: item.volumeRatio,
              streakDays: streak.days,
              streakDirection: streak.direction,
            };
          } catch (err) {
            console.error(`[volume-surge] ${item.market} ${item.symbol} 連漲天數計算失敗，跳過這一檔：`, err);
            return null;
          }
        }
      );

      return results
        .filter((r): r is VolumeSurgeItem => r !== null)
        .sort((a, b) => b.streakDays - a.streakDays);
    }
  );
}
