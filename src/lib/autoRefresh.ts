import { getMarketStatus } from "@/lib/marketStatus";
import { isTwQuoteWindow } from "@/lib/pollingSchedule";

/**
 * 「待在同一頁不動也要自動更新」的節奏單一權威來源（2026-10-06 使用者：「股價、漲幅等網站上的全部資訊
 * 我希望不要等使用者切換頁面或重整才更新」）。純函式、無 I/O、有測試。
 *
 * 全站資料分三類，各用一套共用機制，不要每頁各寫一套：
 *  1. 報價類（個股報價頭、關注清單、指數、焦點榜、台指期、到價提醒）：useLivePolling＋pollingSchedule，
 *     盤中 30 秒，已存在。
 *  2. 用戶端抓取的 AI／彙整卡（今日快報、今日建議、技術訊號共振、新聞牆）：useFetchOnce 的 refresh 選項，
 *     節奏見 clientRefreshMs。
 *  3. 伺服器渲染的區塊（個股頁的基本面／財報／籌碼／五檔、成績看板、總經卡、市場狀態徽章）：
 *     layout 掛一個 PageAutoRefresh，依路徑呼叫 router.refresh()，節奏見 serverRefreshMs。
 * 三者都「分頁在背景時暫停、切回前景立刻補抓」（useLivePolling 的 pauseWhenHidden）。
 */

/** 盤中（台股輪詢窗 08:30~14:30 或美股盤中）。 */
export function isAnyMarketLive(now: Date = new Date()): boolean {
  return isTwQuoteWindow(now) || getMarketStatus("US", now) === "open";
}

/**
 * 用戶端抓取的卡片（快報、今日建議、技術訊號共振、新聞牆）多久重抓一次：盤中 5 分鐘、其餘 20 分鐘
 * （2026-10-08 為節省 Redis 免費額度由 3／10 分鐘放寬：這些內容本來就是依固定時點才重寫，更頻繁只是白讀快取）。
 * 這些內容由伺服器依固定時點重寫（aiSchedule.ts）並快取，重抓只是讀快取（不會觸發 AI），
 * 5 分鐘足以在新時點寫好後（cron 每 5 分鐘暖一次）盡快換上。
 */
export const CLIENT_REFRESH_LIVE_MS = 5 * 60_000;
export const CLIENT_REFRESH_IDLE_MS = 20 * 60_000;
export function clientRefreshMs(now: Date = new Date()): number {
  return isAnyMarketLive(now) ? CLIENT_REFRESH_LIVE_MS : CLIENT_REFRESH_IDLE_MS;
}

/** 伺服器渲染區塊（router.refresh）的節奏。 */
export const SERVER_REFRESH_LIVE_MS = 3 * 60_000;
export const SERVER_REFRESH_IDLE_MS = 15 * 60_000;
/** 外殼大多是用戶端輪詢的頁面（首頁、焦點榜），伺服器渲染的只剩總經卡、市場狀態徽章：5 分鐘。 */
export const SERVER_REFRESH_SHELL_MS = 5 * 60_000;

/**
 * 這個路徑的伺服器渲染內容多久 router.refresh() 一次；null＝不需要。
 *  - /stock/*：基本面（本益比隨股價）、五檔、籌碼、財報、重大訊息——盤中 3 分鐘、其餘 15 分鐘（股價本身由用戶端 30 秒輪詢，
 *    這些是每日或更慢才變的區塊，2026-10-08 由 60 秒放寬以省 Redis 指令）。
 *  - /scoreboard：每日學習彙總，15 分鐘。
 *  - /、/highlights：5 分鐘（只剩總經卡與市場狀態徽章是伺服器渲染；報價與榜單由用戶端 30 秒輪詢）。
 *  - /search、/action、/news、/login 與其他：伺服器端只有外殼，內容全是用戶端抓取，不需要。
 */
export function serverRefreshMs(pathname: string, now: Date = new Date()): number | null {
  if (pathname.startsWith("/stock/")) return isAnyMarketLive(now) ? SERVER_REFRESH_LIVE_MS : SERVER_REFRESH_IDLE_MS;
  if (pathname === "/scoreboard") return SERVER_REFRESH_IDLE_MS;
  if (pathname === "/" || pathname === "/highlights") return SERVER_REFRESH_SHELL_MS;
  return null;
}
