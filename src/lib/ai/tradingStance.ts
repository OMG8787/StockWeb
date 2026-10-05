import { getTwTradingPhase, taipeiDayKey, type TwTradingPhase } from "@/lib/pollingSchedule";

/**
 * 「現在該用什麼立場回答買賣」——2026-10-05 使用者要求：
 *  - 盤中（含開盤前）照現狀；
 *  - 13:30～14:30 盤後定價交易時段：「現在買不買」＝「今天盤後定價還能不能買」（以當日收盤價成交）；
 *  - 14:30 之後到隔天開盤前：以「明天整個交易時段（開盤與盤中）怎麼操作」回答；週末休市以「下一個交易日」。
 *    （2026-10-05 使用者：「我不是指開盤就直接買，盤中也可以買」——原本只看開盤那一刻，等回檔的股票
 *    被寫成「開盤沒有可直接買的」，讀起來像明天都不能買。）
 * 時段判斷一律用 pollingSchedule.ts 的 getTwTradingPhase（不另寫一套時間邏輯）。
 * 今日建議頁的標題、提示詞、快取 key 也都從這裡取，確保一致（純函式、可用假時鐘測試）。
 */

export type BriefMode = "today" | "next-open";

export interface TradingStance {
  phase: TwTradingPhase;
  /** 今日建議頁的模式：today＝今日建議；next-open＝明日／下個交易日操作建議（開盤＋盤中） */
  briefMode: BriefMode;
  /** 頁面標題：「今日建議」「明日操作建議」「下個交易日操作建議」 */
  briefTitle: string;
  /** 下一個開盤的交易日（台北，M/D＋星期），next-open 模式才有意義 */
  nextOpenLabel: string;
  /** 附在 AI 參考資料裡的一行「目前時段與回答立場」 */
  stanceLine: string;
}

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];

/** 從台北今天往後找下一個平日（不含今天）。國定假日不處理。 */
function nextWeekdayLabel(now: Date): { label: string; isTomorrow: boolean } {
  const [y, m, d] = taipeiDayKey(now).split("-").map(Number);
  // 用 UTC 正午表示台北日期，只做日曆加減，避免時區換算誤差。
  const base = new Date(Date.UTC(y, m - 1, d, 12));
  for (let i = 1; i <= 7; i++) {
    const next = new Date(base.getTime() + i * 86_400_000);
    const wd = next.getUTCDay();
    if (wd !== 0 && wd !== 6) {
      return { label: `${next.getUTCMonth() + 1}/${next.getUTCDate()}（週${WEEKDAY_ZH[wd]}）`, isTomorrow: i === 1 };
    }
  }
  return { label: "下一個交易日", isTomorrow: false };
}

export function getTradingStance(now: Date = new Date()): TradingStance {
  const phase = getTwTradingPhase(now);
  const next = nextWeekdayLabel(now);
  const nextOpenWord = next.isTomorrow ? `明天 ${next.label}` : `下一個交易日 ${next.label}`;
  const nextDayWord = next.isTomorrow ? "明天" : "下一個交易日";
  // 收盤後／週末共用：明天整個交易時段（開盤＋盤中）的操作計畫。
  const sessionPlan = `進場要寫成${nextDayWord}整個交易時段（開盤與盤中）的操作計畫：建議買進的寫「${nextDayWord}開盤或盤中可分批買」＋拉回加碼參考價（評等有附時）＋買進後出場價；不可寫成「盤中回到 A～B 才買」「開盤沒有可直接買的」這種讓人以為${nextDayWord}都不能買的句子（2026-10-05 使用者：給了區間到了又說不建議，優柔寡斷）；不可說「現在盤中」或「現在掛單可成交」。`;
  switch (phase) {
    case "pre-open":
      return {
        phase,
        briefMode: "today",
        briefTitle: "今日建議",
        nextOpenLabel: next.label,
        stanceLine:
          "【目前時段與回答立場】台股今天尚未開盤（09:00 開盤）。使用者問「現在買不買／賣不賣」時，以「今天開盤要不要買／賣」的立場回答；資料裡的價格是前一個交易日收盤後的數字。",
      };
    case "intraday":
      return {
        phase,
        briefMode: "today",
        briefTitle: "今日建議",
        nextOpenLabel: next.label,
        stanceLine:
          "【目前時段與回答立場】台股盤中（09:00～13:30）。使用者問「現在買不買／賣不賣」時，以「現在盤中」的立場回答；現價會隨盤變動。",
      };
    case "after-hours-fixed":
      return {
        phase,
        briefMode: "today",
        briefTitle: "今日建議",
        nextOpenLabel: next.label,
        stanceLine:
          `【目前時段與回答立場】台股一般交易已收盤，現在是盤後定價交易時段（13:30～14:30）。使用者問「現在買不買／賣不賣」時，要以「今天盤後定價還能不能買／賣」的立場回答：盤後定價一律以今天的收盤價成交（14:30 撮合），不能自己指定價格；要拿收盤價對照本站評等與買進區間判斷，收盤價不在買進區間就說「盤後定價不建議買」，並補一句${nextOpenWord}開盤與盤中的做法。`,
      };
    case "after-close":
      return {
        phase,
        briefMode: "next-open",
        briefTitle: next.isTomorrow ? "明日操作建議" : "下個交易日操作建議",
        nextOpenLabel: next.label,
        stanceLine:
          `【目前時段與回答立場】台股今天已收盤（含盤後定價交易都已結束），下一次開盤是${nextOpenWord} 09:00。使用者問「現在買不買／賣不賣」時，一律以「${nextDayWord}交易時段（開盤與盤中）要不要買／賣、怎麼操作」的立場回答，用今天收盤後的資料；${sessionPlan}`,
      };
    case "weekend":
      return {
        phase,
        briefMode: "next-open",
        briefTitle: "下個交易日操作建議",
        nextOpenLabel: next.label,
        stanceLine:
          `【目前時段與回答立場】今天週末休市，下一次開盤是${nextOpenWord} 09:00。使用者問「現在買不買／賣不賣」時，一律以「下一個交易日交易時段（開盤與盤中）要不要買／賣、怎麼操作」的立場回答，用最近一個交易日收盤後的資料；${sessionPlan}不可說「今天」。`,
      };
  }
}
