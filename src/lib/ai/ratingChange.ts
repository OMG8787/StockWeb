import { kvEnabled, redis } from "@/lib/data/kv";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { RATING_LOG_KEY_PREFIX, type RatingLogEntry } from "./ratingLog";
import type { RatingCode, SiteRating } from "./siteRating";

/**
 * 評等「跟前一個交易日不同」時的說明（2026-10-06 使用者回報：前一天說南亞「不要追高」，今天推薦南亞建議買進，
 * 使用者問「昨天你不是說南亞不要追高」——回答沒有交代為什麼變了）。
 *
 * 前一天的結論從評等紀錄（ratingLog.ts，每天每檔每結論記第一次）讀；原因由程式比對：
 * 舊評等「等回檔」→ 規則改版（2026-10-05 起果斷二分）；其餘列出改變的面向、追高防護、價格變化。
 * 純比對邏輯（describeRatingChange）有測試；讀 Redis 的部分 fail open。
 */

export const RATING_CHANGE_TITLE = "【評等與前一交易日不同】";
/** 往回找幾天的評等紀錄（涵蓋週末與連假）。 */
const LOOKBACK_DAYS = 6;
const CODES: RatingCode[] = ["buy", "buy-on-pullback", "avoid"];

/** 只看「買或不買」大類有沒有變：舊的等回檔（現價不買）算不買。 */
const buyNow = (code: RatingCode) => code === "buy";

const fmtDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

export interface CurrentRatingForChange {
  name: string;
  symbol: string;
  price: number;
  rating: Pick<SiteRating, "code" | "label">;
  facets: Array<{ name: string; verdict: string }>;
}

/** 前一天紀錄 vs 今天評等 → 一段說明（沒變回 null）。純函式。 */
export function describeRatingChange(prev: RatingLogEntry, cur: CurrentRatingForChange): string | null {
  if (buyNow(prev.code) === buyNow(cur.rating.code)) return null;
  const reasons: string[] = [];
  if (prev.code === "buy-on-pullback") {
    reasons.push(
      "本站 10/5 晚間起評等規則改版：不再有「等回檔／現價不買」，體質過關的一律果斷判建議買進、短線急漲改為風險提示（擴大回測 198 檔：等回檔與追高組之後表現並沒有比較差，原本的寫法讓使用者錯過太多機會）"
    );
  }
  const facetChanges = cur.facets
    .map((f) => {
      const key = f.name.replace(/（.*$/, "");
      const before = Object.entries(prev.facets ?? {}).find(([k]) => k.replace(/（.*$/, "") === key)?.[1];
      return before && before !== f.verdict ? `${key}由【${before}】變【${f.verdict}】` : "";
    })
    .filter(Boolean);
  if (facetChanges.length > 0) reasons.push(`面向改變：${facetChanges.join("、")}`);
  if (prev.price > 0 && cur.price > 0) {
    const pct = Math.round(((cur.price - prev.price) / prev.price) * 1000) / 10;
    if (Math.abs(pct) >= 1) reasons.push(`股價由 ${prev.price} 變為 ${cur.price}（${pct > 0 ? "+" : ""}${pct}%）`);
  }
  if (reasons.length === 0) reasons.push("各面向評分與價位條件的細微變化，跨過了本站的買進門檻");
  return `${RATING_CHANGE_TITLE}${cur.name}(${cur.symbol})：${fmtDay(prev.day)}本站評等是「${prev.label}」，現在是「${cur.rating.label}」。原因：${reasons.join("；")}。`;
}

/** 讀每檔「今天以前最近一天」的評等紀錄（一天有多筆時取最晚那筆）。讀不到回空 Map。 */
export async function readPreviousRatings(symbols: string[], now: Date = new Date()): Promise<Map<string, RatingLogEntry>> {
  const out = new Map<string, RatingLogEntry>();
  if (!kvEnabled || !redis || symbols.length === 0) return out;
  const today = taipeiDayKey(now);
  const days: string[] = [];
  for (let i = 1; i <= LOOKBACK_DAYS; i++) days.push(taipeiDayKey(new Date(now.getTime() - i * 86400_000)));
  try {
    const syms = symbols.map((s) => s.toUpperCase());
    const fields = syms.flatMap((s) => CODES.map((c) => `${s}#${c}`));
    const p = redis.pipeline();
    for (const day of days) p.hmget(`${RATING_LOG_KEY_PREFIX}${day}`, ...fields);
    const results = (await p.exec()) as Array<Record<string, unknown> | null>;
    results.forEach((h) => {
      if (!h) return;
      for (const v of Object.values(h)) {
        if (v == null) continue;
        const e = (typeof v === "string" ? JSON.parse(v) : v) as RatingLogEntry;
        if (!e?.symbol || e.day >= today) continue;
        const k = e.symbol.toUpperCase();
        const had = out.get(k);
        // 越近的一天優先；同一天取最晚那筆
        if (!had || e.day > had.day || (e.day === had.day && e.at > had.at)) out.set(k, e);
      }
    });
  } catch {
    // fail open
  }
  return out;
}

/** 多檔一起：回傳有改變的那幾段說明（給 AI 的參考資料）。 */
export async function describeRatingChanges(current: CurrentRatingForChange[]): Promise<string> {
  const prev = await readPreviousRatings(current.map((c) => c.symbol));
  return current
    .map((c) => {
      const p = prev.get(c.symbol.toUpperCase());
      return p ? describeRatingChange(p, c) : null;
    })
    .filter(Boolean)
    .join("\n");
}
