import { taipeiWeekday } from "@/lib/pollingSchedule";

/**
 * 模擬倉「盤中檢查」時點（2026-10-14 使用者：「我想設定成 10 點、11:30、13:00 檢查看是否需要交易，然後需要有紀錄」）。
 * 設成「盤中」的模擬倉在這三個時點用即時價判斷、需要就交易，每次檢查（含沒交易）都記一筆檢查紀錄；
 * 收盤後 16:40 只結算淨值、不再交易。外部排程每 5 分鐘打一次 /api/cron/warm-cache，到了時點窗口就順帶執行（同一時點每個模擬倉只做一次）。
 */
export interface SimCheckSlot {
  id: "1000" | "1130" | "1300" | "manual";
  label: string;
  /** 台北時間當日第幾分鐘開始（含） */
  start: number;
  /** 最晚到第幾分鐘（含）還算這個時點 */
  end: number;
}

export const SIM_CHECK_SLOTS: readonly SimCheckSlot[] = [
  { id: "1000", label: "10:00", start: 10 * 60, end: 11 * 60 + 29 },
  { id: "1130", label: "11:30", start: 11 * 60 + 30, end: 12 * 60 + 59 },
  { id: "1300", label: "13:00", start: 13 * 60, end: 13 * 60 + 29 },
];

/** 一個模擬倉最多保留幾筆檢查紀錄（三個時點 × 約 30 個交易日） */
export const SIM_CHECK_LOG_KEEP = 90;

export function currentCheckSlot(now: Date = new Date()): SimCheckSlot | null {
  const wd = taipeiWeekday(now);
  if (wd === 0 || wd === 6) return null;
  const m = ((now.getUTCHours() + 8) % 24) * 60 + now.getUTCMinutes(); // 台北固定 UTC+8
  return SIM_CHECK_SLOTS.find((s) => m >= s.start && m <= s.end) ?? null;
}

/** 一筆檢查紀錄（存在 Sims 列的 CheckLog 欄，JSON 陣列，舊的在前） */
export interface SimCheck {
  day: string;
  slot: SimCheckSlot["id"];
  /** 台北時間 HH:MM */
  at: string;
  scanned: number;
  buys: number;
  sells: number;
  /** 這次的交易摘要（最多 6 筆） */
  trades: string[];
  note: string;
}
