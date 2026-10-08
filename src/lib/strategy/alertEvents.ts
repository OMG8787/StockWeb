import type { AlertNotice } from "./alertFormat";

/**
 * 「今日事件」紀錄（瀏覽器端）：每次跳出通知時同步記一筆，提醒頁可以隨時回頭看今天發生了哪些事，
 * 不怕通知被關掉或錯過。只存在這台裝置的瀏覽器，保留最近 3 天、最多 100 筆。
 */

export interface AlertEvent extends AlertNotice {
  at: string;
}

export const ALERT_EVENTS_CHANGED = "stockradar:alert-events";
const KEY = "sw_alert_events";
const KEEP_MS = 3 * 86_400_000;
const KEEP_N = 100;

export function readEvents(): AlertEvent[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]") as AlertEvent[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function recordEvents(notices: AlertNotice[]): void {
  if (notices.length === 0) return;
  try {
    const at = new Date().toISOString();
    const cutoff = Date.now() - KEEP_MS;
    const merged = [...notices.map((n) => ({ ...n, at })), ...readEvents()].filter((e) => Date.parse(e.at) >= cutoff).slice(0, KEEP_N);
    localStorage.setItem(KEY, JSON.stringify(merged));
    window.dispatchEvent(new Event(ALERT_EVENTS_CHANGED));
  } catch {
    // 無痕模式存不了：通知照常跳，只是提醒頁沒有歷史
  }
}

export function clearEvents(): void {
  try {
    localStorage.removeItem(KEY);
    window.dispatchEvent(new Event(ALERT_EVENTS_CHANGED));
  } catch {
    // 同上
  }
}
