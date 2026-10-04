import { getMarketStatus } from "@/lib/marketStatus";
import { isTwQuoteWindow } from "@/lib/pollingSchedule";
import type { Market } from "./types";

/**
 * 全站「過期先回舊資料、背景更新」（stale-while-revalidate）寬限期的單一權威來源
 * （機制見 cache.ts 的 readThroughSwr）。2026-10-04 使用者要求：快取過期後的第一位
 * 訪客不能現場等整個市場報價或 AI 重算。這裡只放「多久算可接受的舊資料」這組
 * 數字與挑選規則，各資料檔案只負責把結果傳給 cached()／降級變體。
 */

/** 即時報價類（個股報價、全市場報價表、指數、台指期、當日走勢）盤中的寬限期。 */
export const LIVE_SWR_MS = 5 * 60_000;
/**
 * 即時報價類在收盤後／週末的寬限期：數字不會再變，舊值就是正確值。拉到 3 天，
 * 讓週五收盤後寫入的值能撐過整個週末（週末不跑預熱排程），週一第一位訪客也
 * 不用現場等。仍搭配 LIVE_REVALIDATE_WAIT_MS：上游快的時候照樣回新抓的值。
 */
export const OFF_HOURS_SWR_MS = 3 * 24 * 60 * 60_000;
/**
 * 即時報價類遇到過期值時，先等背景重算這麼久：來得及就回新值（盤中輪詢不會因為
 * SWR 每一輪都晚一拍），來不及才回舊值。1.5 秒是「首頁 5 秒內完整顯示」預算裡
 * 留給單一資料源的上限。
 */
export const LIVE_REVALIDATE_WAIT_MS = 1_500;
/** AI 快報／今日建議／新聞牆（含 AI 挑選）的寬限期：絕不讓訪客現場等 AI。 */
export const AI_SWR_MS = 60 * 60_000;
/** 昂貴的全市場掃描（技術指標篩選、多訊號共振、市場歷史包、籌碼整包）的寬限期。 */
export const HEAVY_SWR_MS = 60 * 60_000;

/** 每日／每週才更新一次的全市場整包（外資持股、集保大戶、融資融券、三大法人）。 */
export const DAILY_DATA_SWR_MS = 24 * 60 * 60_000;

/** 這個市場現在是不是「報價會變動」的時段（台股用輪詢窗 08:30~14:30，美股用盤中）。 */
function isLiveSession(market: Market): boolean {
  return market === "TW" ? isTwQuoteWindow() : getMarketStatus("US") === "open";
}

/** 即時報價類資料的 SWR 選項：盤中寬限 5 分鐘、盤後／週末 3 天，過期時先等 1.5 秒。 */
export function liveSwrOptions(market: Market): { staleWhileRevalidateMs: number; revalidateWaitMs: number } {
  return {
    staleWhileRevalidateMs: isLiveSession(market) ? LIVE_SWR_MS : OFF_HOURS_SWR_MS,
    revalidateWaitMs: LIVE_REVALIDATE_WAIT_MS,
  };
}
