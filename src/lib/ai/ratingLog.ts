import { after } from "next/server";
import { kvEnabled, redis } from "@/lib/data/kv";
import { getTwTradingPhase, taipeiDayKey, type TwTradingPhase } from "@/lib/pollingSchedule";
import type { RatingCode } from "./siteRating";
import type { StockRatingResult } from "./stockRating";
import type { RatingFeatures } from "./learning/features";
import type { MarketRegime } from "./learning/regime";

/**
 * 本站綜合評等紀錄（2026-10-05 使用者確認設計）：推薦與不推薦都存，事後用
 * scripts/check-rating-log.py 追蹤 1／5／20 日報酬與勝率，回頭調整評分門檻。
 *
 * 儲存：Redis 一天一個 hash `rating-log:v1:{台北日期}`，field＝`{代號}#{結論}`、value＝JSON。
 * - 「同一檔每交易日只記第一次、盤中評等改變時再記一筆」：用 HSETNX——同一天同一個結論只有第一筆
 *   寫得進去，結論變了 field 不同就會再記一筆（A→B→A 的第二次 A 不會再記，屬已知簡化）。
 * - 省指令：同一個 serverless 執行個體記過的 field 放記憶體，不重複打 Redis；真的要寫時
 *   HSETNX＋EXPIRE 合成一個 pipeline（一次 HTTP）。
 * - 大小：每筆約 0.6KB（2026-10-05 加判斷依據特徵 feat 後約 0.9KB），一天幾十～一兩百檔，一年約 10MB 內；key 保留 400 天。
 * - fail open：沒有 Redis、寫入失敗都安靜略過，不影響評等回應；用 after() 在回應送出後才寫。
 */

export const RATING_LOG_KEY_PREFIX = "rating-log:v1:";

/**
 * 評等紀錄的 Redis hash key 與 field——唯一定義處（2026-10-06 整合稽核：原本 ratingLog／aiJudge／learningStore／ratingChange
 * 各自手拼 `${代號}#${結論}`，任何一邊改格式其他邊就讀不到）。學習工作的 learning:v1:eval:{日期} 也用同一個 field。
 */
export function ratingLogKey(day: string): string {
  return `${RATING_LOG_KEY_PREFIX}${day}`;
}
export function ratingLogField(symbol: string, code: RatingCode): string {
  return `${symbol}#${code}`;
}
const RATING_LOG_TTL_SECONDS = 400 * 86_400;

/**
 * 「哪些日期有評等紀錄」的索引（Redis set）。2026-10-08 量到：一次即時提醒檢查要 1000 個 Redis 指令，
 * 主因是讀評等紀錄／確認狀態時「不管有沒有資料，往回逐日各讀一次」（200 天＝201 個指令），
 * 5 秒輪詢一小時就能用掉 72 萬次、把免費額度（每月 50 萬）一次燒光。有了索引只讀真的有資料的日子。
 * 索引第一次使用時用舊辦法掃描一次建立（往回 400 天，一次性），之後每次寫入評等紀錄就順手加進去；
 * 最近 3 天不管索引有沒有都一定會查（別的實例剛寫的日子，索引暫存最多慢 15 秒才看到也不會漏）。
 */
const DAYS_INDEX_KEY = "rating-days:v1";
const DAYS_BUILT_KEY = "rating-days:v1:built";
const DAYS_CACHE_MS = 15_000;
const SCAN_BACK_DAYS = 400;
let daysCache: { at: number; days: Set<string> } | null = null;

async function loadDaysIndex(now: Date): Promise<Set<string>> {
  if (daysCache && Date.now() - daysCache.at < DAYS_CACHE_MS) return daysCache.days;
  if (!redis) throw new Error("no redis");
  if (!(await redis.get(DAYS_BUILT_KEY))) {
    // 一次性建索引：用舊辦法逐日看哪天有資料
    const all: string[] = [];
    for (let i = 0; i <= SCAN_BACK_DAYS; i++) all.push(taipeiDayKey(new Date(now.getTime() - i * 86_400_000)));
    const p = redis.pipeline();
    for (const d of all) p.hgetall(ratingLogKey(d));
    const results = (await p.exec()) as Array<Record<string, unknown> | null>;
    const found = all.filter((_, i) => results[i] && Object.keys(results[i]!).length > 0);
    if (found.length) await redis.sadd(DAYS_INDEX_KEY, found[0], ...found.slice(1));
    await redis.set(DAYS_BUILT_KEY, 1);
  }
  const members = ((await redis.smembers(DAYS_INDEX_KEY)) ?? []) as string[];
  daysCache = { at: Date.now(), days: new Set(members) };
  return daysCache.days;
}

/** 從候選日期裡留下「有評等紀錄」的日子（加上最近 3 天一定保留）；索引讀不到時原樣回傳（退回舊辦法，只是指令多） */
export async function existingRatingLogDays(candidates: string[], now: Date = new Date()): Promise<string[]> {
  if (!kvEnabled || !redis || candidates.length === 0) return candidates;
  try {
    const idx = await loadDaysIndex(now);
    const recentFrom = taipeiDayKey(new Date(now.getTime() - 3 * 86_400_000));
    return candidates.filter((d) => idx.has(d) || d >= recentFrom);
  } catch (err) {
    console.warn("[rating-log] 日期索引讀取失敗，改逐日掃描：", err);
    return candidates;
  }
}

/** 寫入評等紀錄的日子時，同步把日期加進索引 */
export function noteRatingLogDay(p: { sadd: (key: string, ...members: string[]) => unknown }, day: string): void {
  p.sadd(DAYS_INDEX_KEY, day);
  daysCache?.days.add(day);
}

export type RatingSource = "today-brief" | "ai-ask" | "stock-button" | "tech-screen" | "sim-portfolio" | "other";

export const RATING_SOURCE_LABEL: Record<RatingSource, string> = {
  "today-brief": "今日建議",
  "ai-ask": "AI問答",
  "stock-button": "個股按鈕（問AI關於）",
  "tech-screen": "AI問答技術篩選",
  "sim-portfolio": "AI模擬投資組合",
  other: "其他",
};

export type RatingSession = "開盤前" | "盤中" | "盤後定價" | "明日開盤";

export function ratingSession(phase: TwTradingPhase): RatingSession {
  switch (phase) {
    case "pre-open":
      return "開盤前";
    case "intraday":
      return "盤中";
    case "after-hours-fixed":
      return "盤後定價";
    default:
      return "明日開盤";
  }
}

export interface RatingLogEntry {
  /** UTC ISO 時間 */
  at: string;
  /** 台北日期 YYYY-MM-DD */
  day: string;
  session: RatingSession;
  symbol: string;
  name: string;
  market: string;
  price: number;
  code: RatingCode;
  label: string;
  holdingLabel: string;
  reason: string;
  /** 五面向評分（名稱→支持／中性／不支持／無資料） */
  facets: Record<string, string>;
  zone: { low: number; high: number } | null;
  noChase: number | null;
  exit: number | null;
  /** 觸發的追高防護 id */
  chaseHits: string[];
  source: RatingSource;
  /** 判斷依據的具體狀態（2026-10-05 起才有；舊紀錄 undefined，見 learning/features.ts） */
  feat?: RatingFeatures;
  /** 評等當下市況（多頭／空頭／盤整；2026-10-05 起才有，抓不到加權指數時 null） */
  rg?: MarketRegime | null;
  /**
   * AI 判斷層在程式評等之上調整後的結論（最多 ±1 級）與理由（aiJudge.ts，2026-10-05 第二階段起寫入；
   * 只有評等實際被今日建議／個股問答使用、且 AI 判斷成功時才有）；冠軍／挑戰者比較時「程式評等 code」與「ai.code」各算各的獎勵。
   */
  ai?: AiAdjustment;
}

/** 第二階段預留：AI 調整後結論。 */
export interface AiAdjustment {
  code: RatingCode;
  /** 相對程式評等調整幾級（-1／0／+1；buy 為最高級） */
  delta: -1 | 0 | 1;
  reason: string;
  /** AI 自評把握程度（第二階段起才有） */
  confidence?: "高" | "中" | "低";
  /** 哪個模型做的調整（例如 gemini） */
  model?: string;
}

export function buildRatingLogEntry(r: StockRatingResult, source: RatingSource, now: Date = new Date()): RatingLogEntry {
  return {
    at: now.toISOString(),
    day: taipeiDayKey(now),
    session: ratingSession(getTwTradingPhase(now)),
    symbol: r.symbol,
    name: r.name,
    market: r.market,
    price: r.price,
    code: r.rating.code,
    label: r.rating.label,
    holdingLabel: r.rating.holdingLabel,
    reason: r.rating.reason,
    facets: Object.fromEntries(r.facets.map((f) => [f.name.replace(/（.*$/, ""), f.verdict])),
    zone: r.rating.zone,
    noChase: r.rating.noChase,
    exit: r.rating.exit,
    chaseHits: r.rating.chaseHits.map((h) => h.id),
    source,
    ...(r.features ? { feat: r.features } : {}),
    ...(r.regime !== undefined ? { rg: r.regime } : {}),
  };
}

/** 這個執行個體已經寫過（或確認已存在）的 field，避免每次快取命中都打 Redis。 */
const seen = new Set<string>();

async function writeEntry(entry: RatingLogEntry): Promise<void> {
  if (!kvEnabled || !redis) return;
  const key = ratingLogKey(entry.day);
  const field = ratingLogField(entry.symbol, entry.code);
  const memo = `${key}|${field}`;
  if (seen.has(memo)) return;
  seen.add(memo);
  if (seen.size > 5000) seen.clear();
  try {
    const p = redis.pipeline();
    p.hsetnx(key, field, JSON.stringify(entry));
    p.expire(key, RATING_LOG_TTL_SECONDS);
    noteRatingLogDay(p, entry.day);
    await p.exec();
  } catch (err) {
    seen.delete(memo);
    console.warn("[rating-log] 寫入失敗（略過）:", err);
  }
}

/** 記一筆評等（不等待、不丟錯）。在請求範圍內用 after() 排到回應之後；不在請求範圍就直接背景送出。 */
export function logRating(r: StockRatingResult, source: RatingSource): void {
  if (!kvEnabled) return;
  let entry: RatingLogEntry;
  try {
    entry = buildRatingLogEntry(r, source);
  } catch {
    return;
  }
  const task = () => writeEntry(entry);
  try {
    after(task);
  } catch {
    void task().catch(() => undefined);
  }
}

/** 讀取區間內的紀錄（含頭尾，台北日期），舊到新。 */
export async function readRatingLog(from: string, to: string): Promise<RatingLogEntry[]> {
  if (!kvEnabled || !redis) return [];
  const days: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = start; d <= end && days.length < 400; d = new Date(d.getTime() + 86_400_000)) {
    days.push(d.toISOString().slice(0, 10));
  }
  if (days.length === 0) return [];
  const present = await existingRatingLogDays(days);
  if (present.length === 0) return [];
  const p = redis.pipeline();
  for (const day of present) p.hgetall(ratingLogKey(day));
  const results = (await p.exec()) as Array<Record<string, unknown> | null>;
  const out: RatingLogEntry[] = [];
  for (const h of results) {
    if (!h) continue;
    for (const v of Object.values(h)) {
      // Upstash 會自動把 JSON 字串解析成物件；保險起見兩種都接。
      const e = (typeof v === "string" ? JSON.parse(v) : v) as RatingLogEntry;
      if (e && e.symbol) out.push(e);
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
