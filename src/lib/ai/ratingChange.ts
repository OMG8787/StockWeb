import { kvEnabled, redis } from "@/lib/data/kv";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { ratingLogField, ratingLogKey, type RatingLogEntry } from "./ratingLog";
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
  rating: Pick<SiteRating, "code" | "label"> & { holdingLabel?: string };
  /** detail 有給時，改變的面向會附現在的具體數字（例如三大法人合計 -3,200 張） */
  facets: Array<{ name: string; verdict: string; detail?: string }>;
  /** 使用者持有中（關注清單有成本）：「已持有」結論（續抱／加碼／減碼／出場）改變也要說明 */
  held?: boolean;
}

/** 持有建議的大類（續抱、加碼同屬保留部位；減碼、出場各一類）。 */
export function holdingClass(label: string | undefined): "keep" | "reduce" | "exit" | null {
  if (!label) return null;
  const core = label.replace(/[（(].*$/, "");
  if (/出場|停損|賣出/.test(core)) return "exit";
  if (/減碼/.test(core)) return "reduce";
  return "keep";
}

/** 面向說明最多附幾個字（太長會稀釋重點）。 */
const FACET_DETAIL_MAX = 60;

/** 前一天紀錄 vs 今天評等 → 一段說明（沒變回 null）。純函式。 */
export function describeRatingChange(prev: RatingLogEntry, cur: CurrentRatingForChange): string | null {
  const buyChanged = buyNow(prev.code) !== buyNow(cur.rating.code);
  // 2026-10-06 使用者回報：「有些是你昨天建議我賣我才賣、建議我買我才買，今天又不一樣」——持有中的
  // 續抱→減碼這類變化（買不買大類沒變）也要交代原因。
  const holdChanged =
    !!cur.held && holdingClass(prev.holdingLabel) != null && holdingClass(prev.holdingLabel) !== holdingClass(cur.rating.holdingLabel);
  if (!buyChanged && !holdChanged) return null;
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
      if (!before || before === f.verdict) return "";
      const d = (f.detail ?? "").replace(/\s+/g, " ").trim();
      const num = d ? `（現在：${d.length > FACET_DETAIL_MAX ? `${d.slice(0, FACET_DETAIL_MAX)}…` : d}）` : "";
      return `${key}由【${before}】變【${f.verdict}】${num}`;
    })
    .filter(Boolean);
  if (facetChanges.length > 0) reasons.push(`面向改變：${facetChanges.join("、")}`);
  if (prev.price > 0 && cur.price > 0) {
    const pct = Math.round(((cur.price - prev.price) / prev.price) * 1000) / 10;
    if (Math.abs(pct) >= 1) reasons.push(`股價由 ${prev.price} 變為 ${cur.price}（${pct > 0 ? "+" : ""}${pct}%）`);
  }
  if (reasons.length === 0) reasons.push("各面向評分與價位條件的細微變化，跨過了本站的買進門檻");
  const what = [
    buyChanged ? `未持有：${fmtDay(prev.day)}「${prev.label}」→現在「${cur.rating.label}」` : "",
    holdChanged ? `已持有：${fmtDay(prev.day)}「${prev.holdingLabel}」→現在「${cur.rating.holdingLabel}」` : "",
  ]
    .filter(Boolean)
    .join("；");
  return `${RATING_CHANGE_TITLE}${cur.name}(${cur.symbol})：${what}。原因：${reasons.join("；")}。`;
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
    const fields = syms.flatMap((s) => CODES.map((c) => ratingLogField(s, c)));
    const p = redis.pipeline();
    for (const day of days) p.hmget(ratingLogKey(day), ...fields);
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

export const RATING_CHANGE_APPENDIX_TITLE = "評等跟前一交易日不同的股票（本站程式說明）";
/** 回答裡提到該檔後這麼多字內，要有「跟前一天不同」的交代。 */
const CHANGE_MENTION_WINDOW = 260;
const CHANGE_MENTION_PATTERN = /前一(?:個)?(?:交易)?日|前一天|昨天|昨日|\d{1,2}\/\d{1,2}|改版|不同|改判|轉為|變為|變成/;

/**
 * 回答後保證（唯一入口，ask.ts postProcessAiAnswer 呼叫）：參考資料有【評等與前一交易日不同】的股票，回答提到它卻沒交代
 * 為什麼跟前一天不同時，在回答最後補上程式寫好的說明（確定性、不重生；2026-10-06 使用者：「今天又不一樣，我搞不懂」）。
 */
export function ensureRatingChangeExplained(answer: string, grounding: string): { text: string; appended: string[] } {
  const lines = grounding.split("\n").filter((l) => l.startsWith(RATING_CHANGE_TITLE));
  if (!answer || lines.length === 0) return { text: answer, appended: [] };
  const missing: string[] = [];
  for (const l of lines) {
    const body = l.slice(RATING_CHANGE_TITLE.length);
    const m = body.match(/^([^()（）]+?)\(([0-9A-Za-z.\-]+)\)/);
    if (!m) continue;
    const keys = [m[2], m[1].trim()].filter((k) => k.length >= 2);
    let mentioned = false;
    let explained = false;
    for (const key of keys) {
      for (let i = answer.indexOf(key); i >= 0 && !explained; i = answer.indexOf(key, i + 1)) {
        mentioned = true;
        if (CHANGE_MENTION_PATTERN.test(answer.slice(i, i + CHANGE_MENTION_WINDOW))) explained = true;
      }
    }
    if (mentioned && !explained) missing.push(body);
  }
  if (missing.length === 0) return { text: answer, appended: [] };
  return {
    text: `${answer.replace(/\s+$/, "")}\n\n${RATING_CHANGE_APPENDIX_TITLE}：\n${missing.map((b) => `- ${b}`).join("\n")}`,
    appended: missing.map((b) => b.match(/\(([0-9A-Za-z.\-]+)\)/)?.[1] ?? b),
  };
}
