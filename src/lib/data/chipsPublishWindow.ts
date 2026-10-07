import { taipeiDayKey } from "@/lib/pollingSchedule";

/**
 * 三大法人全市場表的快取分段（2026-10-07 使用者回報達新：「三大法人當天的買賣超也要參考」）。
 *
 * 個股三大法人（證交所 T86／櫃買）約收盤後 15:00~16:00 才公布。原本整包快取 1 小時、key 不分時段：14:30 抓到的前一交易日表會一路用到
 * 15:30，公布後的第一小時問到的還是前一天的數字。改成 key 帶「台北日期＋時段」：
 * - a：15:00 之前（公布前）——TTL 1 小時，數字不會變。
 * - p：15:00～17:30（公布窗口）——TTL 10 分鐘，公布後最久 10 分鐘就換成當天資料；跨過 15:00 時 key 不同，不會沿用公布前的表。
 * - z：17:30 之後——TTL 1 小時。
 * 週末沒有公布，一律 a。日期進 key，跨日不沿用前一天。
 */
export const CHIPS_PUBLISH_WINDOW_START_MIN = 15 * 60;
export const CHIPS_PUBLISH_WINDOW_END_MIN = 17 * 60 + 30;
export const CHIPS_PUBLISH_WINDOW_TTL_MS = 10 * 60_000;

export type ChipsPhase = "a" | "p" | "z";

export function chipsPhase(now: Date = new Date()): { phase: ChipsPhase; dayKey: string; weekend: boolean } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const pick = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const minutes = Number(pick("hour") || "0") * 60 + Number(pick("minute") || "0");
  const weekend = pick("weekday") === "Sat" || pick("weekday") === "Sun";
  const phase: ChipsPhase = weekend || minutes < CHIPS_PUBLISH_WINDOW_START_MIN ? "a" : minutes < CHIPS_PUBLISH_WINDOW_END_MIN ? "p" : "z";
  return { phase, dayKey: taipeiDayKey(now), weekend };
}

/** 三大法人全市場表的快取 key 與 TTL（baseTtlMs＝平常 TTL）。 */
export function institutionalCacheSpec(baseKey: string, baseTtlMs: number, now: Date = new Date()): { key: string; ttlMs: number } {
  const { phase, dayKey } = chipsPhase(now);
  return { key: `${baseKey}:${dayKey}:${phase}`, ttlMs: phase === "p" ? CHIPS_PUBLISH_WINDOW_TTL_MS : baseTtlMs };
}
