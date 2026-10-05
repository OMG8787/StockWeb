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
const RATING_LOG_TTL_SECONDS = 400 * 86_400;

export type RatingSource = "today-brief" | "ai-ask" | "stock-button" | "tech-screen" | "other";

export const RATING_SOURCE_LABEL: Record<RatingSource, string> = {
  "today-brief": "今日建議",
  "ai-ask": "AI問答",
  "stock-button": "個股按鈕（問AI關於）",
  "tech-screen": "AI問答技術篩選",
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
   * 第二階段預留：AI 判斷層在程式評等之上調整後的結論（最多 ±1 級）與理由。
   * 第一階段一律不寫（undefined）；冠軍／挑戰者比較時「程式評等 code」與「ai.code」各算各的獎勵。
   */
  ai?: AiAdjustment;
}

/** 第二階段預留：AI 調整後結論。 */
export interface AiAdjustment {
  code: RatingCode;
  /** 相對程式評等調整幾級（-1／0／+1；buy 為最高級） */
  delta: -1 | 0 | 1;
  reason: string;
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
  const key = `${RATING_LOG_KEY_PREFIX}${entry.day}`;
  const field = `${entry.symbol}#${entry.code}`;
  const memo = `${key}|${field}`;
  if (seen.has(memo)) return;
  seen.add(memo);
  if (seen.size > 5000) seen.clear();
  try {
    const p = redis.pipeline();
    p.hsetnx(key, field, JSON.stringify(entry));
    p.expire(key, RATING_LOG_TTL_SECONDS);
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
  const p = redis.pipeline();
  for (const day of days) p.hgetall(`${RATING_LOG_KEY_PREFIX}${day}`);
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
