/**
 * 即時提醒的通知內容與鬧鐘判斷（純函式；前端 AlertWatcher、提醒頁與測試共用）。
 * 2026-10-08 使用者要求的通知格式：標題是股票，內文每個策略一行，例如
 *   2330 台積電
 *   AI 策略：買進（建議買進）
 *   我的策略：觀察
 * 沒有任何策略出現訊號的股票不通知。
 */

export type Signal = "buy" | "sell" | null;

export interface AlertLine {
  id: string;
  name: string;
  current: Signal;
  summary: string;
}

export interface AlertItem {
  symbol: string;
  name: string;
  price: number | null;
  allBuy: boolean;
  lines: AlertLine[];
}

export interface AlertNotice {
  title: string;
  body: string;
  tone: "buy" | "sell" | "info";
}

export const AI_LINE_ID = "ai";

/** 每個策略的訊號文字：沒訊號＝觀察；AI 建議策略（本站評等）的賣出側是「先不要買」，買進附上評等名稱 */
export function signalText(l: AlertLine): string {
  if (l.id === AI_LINE_ID) {
    if (l.current === "buy") return `買進（${l.summary}）`;
    if (l.current === "sell") return "先不要買";
    return "觀察";
  }
  return l.current === "buy" ? "買進" : l.current === "sell" ? "賣出" : "觀察";
}

/** 策略名稱縮短：「🤖 AI 建議策略（本站綜合評等）」→「AI 策略」 */
export function lineLabel(l: AlertLine): string {
  return l.id === AI_LINE_ID ? "AI 策略" : l.name;
}

export function formatAlert(it: AlertItem): Omit<AlertNotice, "tone"> {
  const head = `${it.symbol} ${it.name !== it.symbol ? it.name : ""}`.trim() + (it.price != null ? `　${it.price}` : "");
  const lines = it.lines.map((l) => `${lineLabel(l)}：${signalText(l)}`);
  if (it.allBuy && it.lines.length > 1) lines.push(`✅ 全部 ${it.lines.length} 個策略都是買進`);
  return { title: head, body: lines.join("\n") };
}

export function hasSignal(it: AlertItem, notifySell: boolean): boolean {
  return it.lines.some((l) => l.current === "buy" || (notifySell && l.current === "sell"));
}

/**
 * 比對新舊訊號：某檔股票有任一策略「新出現」買進（或賣出，notifySell 時）就通知一次，
 * 內容列出這檔所有策略目前的訊號。第一次看到就已經是買進也會通知（開啟提醒時立刻知道哪些已經是買點）；
 * 賣出只在狀態改變時通知。
 * 訊號消失或沒變不通知。
 */
export function diffAlerts(
  prev: Record<string, string>,
  items: AlertItem[],
  notifySell = true,
): { next: Record<string, string>; notices: AlertNotice[] } {
  const next: Record<string, string> = {};
  const notices: AlertNotice[] = [];
  for (const it of items) {
    let fresh: "buy" | "sell" | null = null;
    for (const l of it.lines) {
      const key = `${it.symbol}|${l.id}`;
      const cur = l.current ?? "";
      next[key] = cur;
      if (prev[key] === cur) continue;
      if (l.current === "buy") fresh = "buy";
      // 賣出只在「從別的狀態變成賣出」時通知（第一次看到就是賣出不通知，避免一開提醒就一堆賣出通知）
      else if (l.current === "sell" && notifySell && key in prev && fresh !== "buy") fresh = "sell";
    }
    if (fresh) notices.push({ ...formatAlert(it), tone: fresh });
  }
  return { next, notices };
}

// ============================================================
// 定時提醒（鬧鐘）
// ============================================================

export interface AlarmSetting {
  id: string;
  /** 台北時間 HH:MM */
  time: string;
  /** weekdays＝週一到週五；daily＝每天 */
  days: "weekdays" | "daily";
  label: string;
  /** 響的時候附上追蹤名單目前有訊號的股票 */
  withSignals: boolean;
  enabled: boolean;
}

export const MAX_ALARMS = 10;
/** 分頁在背景時計時器可能延遲：時間到之後 10 分鐘內還沒響過就補響 */
export const ALARM_GRACE_MIN = 10;

/** 台北現在的日期、星期、分鐘數 */
export function taipeiClock(now: Date = new Date()): { day: string; weekday: number; minutes: number } {
  const t = new Date(now.getTime() + 8 * 3600_000);
  return { day: t.toISOString().slice(0, 10), weekday: t.getUTCDay(), minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

function toMinutes(time: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

/** 現在要響的鬧鐘（fired：今天已經響過的 `${id}|${日期}`） */
export function dueAlarms(alarms: AlarmSetting[], fired: Set<string>, now: Date = new Date()): AlarmSetting[] {
  const c = taipeiClock(now);
  return alarms.filter((a) => {
    if (!a.enabled) return false;
    if (a.days === "weekdays" && (c.weekday === 0 || c.weekday === 6)) return false;
    const at = toMinutes(a.time);
    if (at < 0 || c.minutes < at || c.minutes > at + ALARM_GRACE_MIN) return false;
    return !fired.has(`${a.id}|${c.day}`);
  });
}

export function normalizeAlarms(raw: unknown): AlarmSetting[] {
  if (!Array.isArray(raw)) return [];
  const out: AlarmSetting[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const r = (x ?? {}) as Record<string, unknown>;
    const time = String(r.time ?? "");
    const mins = toMinutes(time);
    if (mins < 0 || mins >= 24 * 60) continue;
    const [h, m] = time.split(":");
    let id = /^[A-Za-z0-9_-]{1,20}$/.test(String(r.id)) ? String(r.id) : `A${mins}`;
    while (seen.has(id)) id = `${id.slice(0, 17)}_${out.length}`;
    seen.add(id);
    out.push({
      id,
      time: `${h.padStart(2, "0")}:${m}`,
      days: r.days === "daily" ? "daily" : "weekdays",
      label: String(r.label ?? "").trim().slice(0, 40),
      withSignals: r.withSignals !== false,
      enabled: r.enabled !== false,
    });
    if (out.length >= MAX_ALARMS) break;
  }
  return out;
}
