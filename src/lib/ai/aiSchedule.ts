import { taipeiDayKey, taipeiWeekday } from "@/lib/pollingSchedule";

/**
 * 較強模型（Gemini 非 lite 思考模型）重寫時點（純邏輯、無 I/O，有測試）。
 *
 * 2026-10-05 使用者確認：非 lite 模型免費層每模型每天只有 20 次（gemini.ts），原本今日建議／快報快取 10 分鐘一過
 * 就重寫，一天會遠超過額度。改成只在「關鍵時點」重寫，其間沿用最近一次版本（不拿 lite 重寫分析文字），
 * 頁面上的即時數字照舊 30 秒更新。排程由 cron-job.org 每 5 分鐘呼叫的 /api/cron/warm-cache 觸發
 * （時段 08:00～14:59、21:00～04:59），沒有訪客時也會照時點產生。
 *
 * 時點都是台北時間 "HH:MM"。交易日以「週一～週五」判斷（本站沒有國定假日行事曆）。
 */

const halfHours = (from: string, to: string): string[] => {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const out: string[] = [];
  for (let m = toMin(from); m <= toMin(to); m += 30) out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  return out;
};

/** 今日建議／明日操作建議：交易日 08:30、盤中每 30 分鐘（09:00～13:30）、13:35（盤後定價）、14:35（明日操作建議）、21:35（美股開盤後）。 */
export const ACTION_BRIEF_SLOTS_TRADING: readonly string[] = ["08:30", ...halfHours("09:00", "13:30"), "13:35", "14:35", "21:35"];
/** 週末：沒有盤中變化，只在早上與晚上各重寫一次（明日／下個交易日操作建議）。 */
export const ACTION_BRIEF_SLOTS_HOLIDAY: readonly string[] = ["08:30", "21:35"];
/** 今日快報：交易日 08:20、10:30、12:30、13:40、21:40、23:30。 */
export const DAILY_BRIEF_SLOTS_TRADING: readonly string[] = ["08:20", "10:30", "12:30", "13:40", "21:40", "23:30"];
/** 週末快報：早晚各一次（美股週五夜盤結果、週末新聞）。 */
export const DAILY_BRIEF_SLOTS_HOLIDAY: readonly string[] = ["08:20", "21:40"];

export interface ScheduleSlot {
  /** 時點所屬的台北日期 YYYY-MM-DD */
  day: string;
  /** "HH:MM" */
  time: string;
  /** 快取 key 用：`${day}T${time}` */
  key: string;
}

function taipeiHHMM(now: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
}

function isWeekday(now: Date): boolean {
  const d = taipeiWeekday(now);
  return d >= 1 && d <= 5;
}

/**
 * 現在所屬的時點＝今天已經到了的最後一個時點；今天第一個時點之前就往回找前一天（或更早）的最後一個時點。
 * `slotsFor`：依日期是否交易日回傳那天的時點。
 */
export function currentSlot(now: Date, trading: readonly string[], holiday: readonly string[]): ScheduleSlot {
  const hhmm = taipeiHHMM(now);
  for (let back = 0; back < 7; back++) {
    const d = new Date(now.getTime() - back * 86400_000);
    const slots = isWeekday(d) ? trading : holiday;
    const passed = back === 0 ? slots.filter((t) => t <= hhmm) : [...slots];
    if (passed.length > 0) {
      const day = taipeiDayKey(d);
      const time = passed[passed.length - 1];
      return { day, time, key: `${day}T${time}` };
    }
  }
  const day = taipeiDayKey(now);
  return { day, time: "00:00", key: `${day}T00:00` };
}

export const actionBriefSlot = (now: Date = new Date()) => currentSlot(now, ACTION_BRIEF_SLOTS_TRADING, ACTION_BRIEF_SLOTS_HOLIDAY);
export const dailyBriefSlot = (now: Date = new Date()) => currentSlot(now, DAILY_BRIEF_SLOTS_TRADING, DAILY_BRIEF_SLOTS_HOLIDAY);

/** AI 判斷層每天最多呼叫幾次（名單股票已合併成一次呼叫，見 aiJudge.ts）。 */
export const AI_JUDGE_DAILY_CALL_LIMIT = 10;

/** 卡片標示：「分析撰寫於 HH:MM（模型），數字即時更新」。generatedAt 是 ISO 字串。 */
export function writtenAtLabel(generatedAt: string, modelName?: string | null, fellBackToLite = false): string {
  const t = taipeiHHMM(new Date(generatedAt));
  const model = modelName ? `（${modelName}${fellBackToLite ? "；較強模型今日額度用完或暫時無法使用，改用此模型" : ""}）` : "";
  return `分析撰寫於 ${t}${model}，數字即時更新`;
}

/** 下一個時點的 "HH:MM"（今天還有就是今天的，否則是之後第一個有時點的日子的第一個）。 */
export function nextSlotTime(now: Date, trading: readonly string[], holiday: readonly string[]): string {
  const hhmm = taipeiHHMM(now);
  for (let ahead = 0; ahead < 7; ahead++) {
    const d = new Date(now.getTime() + ahead * 86400_000);
    const slots = isWeekday(d) ? trading : holiday;
    const later = ahead === 0 ? slots.filter((t) => t > hhmm) : [...slots];
    if (later.length > 0) return later[0];
  }
  return trading[0];
}

export const nextActionBriefSlotTime = (now: Date = new Date()) => nextSlotTime(now, ACTION_BRIEF_SLOTS_TRADING, ACTION_BRIEF_SLOTS_HOLIDAY);

/** 今日建議卡片：名單與價位（程式即時）與分析文字（時點重寫）兩個時間分開標示。 */
export function actionBriefTimeLabel(listAt: string, writtenAt: string | null, modelName?: string | null, fellBackToLite = false): string {
  const list = `名單與價位即時（${taipeiHHMM(new Date(listAt))}）`;
  if (!writtenAt) return `${list}，分析文字暫時無法產生`;
  const model = modelName ? `（${modelName}${fellBackToLite ? "；較強模型今日額度用完或暫時無法使用，改用此模型" : ""}）` : "";
  return `${list}，分析文字撰寫於 ${taipeiHHMM(new Date(writtenAt))}${model}`;
}
