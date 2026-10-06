import { kvEnabled, redis } from "@/lib/data/kv";
import type { ConfirmState } from "./ratingStability";
import { ratingLogField, ratingLogKey, type RatingLogEntry } from "./ratingLog";
import type { HoldingCode, RatingCode } from "./siteRating";

/**
 * 評等翻轉確認狀態的儲存（正式站；回測在記憶體逐日串接，不經過這裡）。2026-10-06 評等穩定化。
 *
 * 一個 Redis hash `rating-confirm:v1`，field＝代號，value＝{ cur: 最近一次算出的狀態（含當天日期）, base: 算 cur 時用的「前一交易日狀態」 }。
 * 算第 D 天的評等時，前一交易日狀態 base：
 *   - 存的 cur.day < D → 就是 cur（那天最後一次的狀態）；
 *   - 存的 cur.day === D（今天已經算過）→ 用存的 base（不能拿今天自己的狀態當昨天）。
 *   - 太久沒算（> MAX_GAP_DAYS 天）→ null（不確認，直接採用今天的結果）。
 * 省指令：同一個執行個體同一天同一檔的 base 放記憶體；只有狀態改變才寫回（HSET＋EXPIRE 一個 pipeline）。
 * fail open：沒有 Redis、讀寫失敗 → base＝null（等於不套確認，結果跟舊版一樣）。
 */

export const RATING_CONFIRM_KEY = "rating-confirm:v1";
const TTL_SECONDS = 30 * 86_400;
/** 前一次評等超過這麼多天（日曆日）就不拿來確認（例如連假後很久沒人問的股票）。 */
export const MAX_GAP_DAYS = 7;

interface Stored {
  cur: ConfirmState;
  base: ConfirmState | null;
}

const baseMemo = new Map<string, ConfirmState | null>();
const lastWritten = new Map<string, string>();

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** 純函式：由存的紀錄推「day 這天要用的前一交易日狀態」。 */
export function baseStateFor(stored: Stored | null, day: string): ConfirmState | null {
  if (!stored?.cur) return null;
  if (stored.cur.day === day) return stored.base ?? null;
  if (stored.cur.day > day || dayDiff(stored.cur.day, day) > MAX_GAP_DAYS) return null;
  return stored.cur;
}

/** 評等紀錄回推時往回看幾個日曆日（連續天數最多數到這裡）。 */
const BOOTSTRAP_LOOKBACK_DAYS = 21;
const LOG_CODES: RatingCode[] = ["buy", "buy-on-pullback", "avoid"];

function holdingCodeOfLabel(label: string): HoldingCode {
  const core = label.replace(/[（(].*$/, "");
  if (/出場/.test(core)) return "exit";
  if (/減碼/.test(core)) return "reduce";
  if (/加碼/.test(core)) return "add";
  return "hold";
}

/**
 * 純函式：還沒有確認狀態時（剛上線、或這檔很久沒被評等），用評等紀錄（每天每檔每結論記第一次）推前一交易日狀態：
 * 取 day 之前最近一天的最後一筆當結論，往前數「買不買大類」連續相同的天數當 streak（把握程度用）。
 */
export function stateFromRatingLog(entries: RatingLogEntry[], day: string): ConfirmState | null {
  const byDay = new Map<string, RatingLogEntry>();
  for (const e of entries) {
    if (!e?.day || e.day >= day) continue;
    const had = byDay.get(e.day);
    if (!had || e.at > had.at) byDay.set(e.day, e);
  }
  const days = [...byDay.keys()].sort().reverse();
  if (days.length === 0 || dayDiff(days[0], day) > MAX_GAP_DAYS) return null;
  const last = byDay.get(days[0])!;
  const isBuy = (c: RatingCode) => c === "buy";
  let streak = 0;
  for (let k = 0; k < days.length; k++) {
    if (k > 0 && dayDiff(days[k], days[k - 1]) > 4) break; // 中間斷超過一個長週末就不再往前數
    if (isBuy(byDay.get(days[k])!.code) !== isBuy(last.code)) break;
    streak++;
  }
  return { code: last.code === "buy-on-pullback" ? "avoid" : last.code, holdingCode: holdingCodeOfLabel(last.holdingLabel ?? ""), pending: null, day: days[0], streak };
}

async function bootstrapFromRatingLog(symbol: string, day: string): Promise<ConfirmState | null> {
  if (!redis) return null;
  const days: string[] = [];
  const base = Date.parse(`${day}T00:00:00Z`);
  for (let i = 1; i <= BOOTSTRAP_LOOKBACK_DAYS; i++) days.push(new Date(base - i * 86_400_000).toISOString().slice(0, 10));
  const p = redis.pipeline();
  for (const d of days) p.hmget(ratingLogKey(d), ...LOG_CODES.map((c) => ratingLogField(symbol, c)));
  const results = (await p.exec()) as Array<Record<string, unknown> | null>;
  const entries: RatingLogEntry[] = [];
  for (const h of results) for (const v of Object.values(h ?? {})) if (v != null) entries.push((typeof v === "string" ? JSON.parse(v) : v) as RatingLogEntry);
  return stateFromRatingLog(entries, day);
}

/** 讀 day 這天的前一交易日狀態（沒有確認狀態時用評等紀錄回推）。 */
export async function readConfirmBase(symbol: string, day: string): Promise<ConfirmState | null> {
  const memo = `${symbol}|${day}`;
  if (baseMemo.has(memo)) return baseMemo.get(memo)!;
  if (!kvEnabled || !redis) return null;
  try {
    const v = await redis.hget<Stored | string>(RATING_CONFIRM_KEY, symbol);
    const stored = (typeof v === "string" ? JSON.parse(v) : v) as Stored | null;
    const base = stored ? baseStateFor(stored, day) : await bootstrapFromRatingLog(symbol, day);
    if (baseMemo.size > 3000) baseMemo.clear();
    baseMemo.set(memo, base);
    return base;
  } catch {
    return null;
  }
}

/** 寫回今天算出的狀態（跟上次寫的相同就不寫）。 */
export async function writeConfirmState(symbol: string, cur: ConfirmState | null | undefined, base: ConfirmState | null): Promise<void> {
  if (!cur || !kvEnabled || !redis) return;
  const value = JSON.stringify({ cur, base } satisfies Stored);
  if (lastWritten.get(symbol) === value) return;
  try {
    const p = redis.pipeline();
    p.hset(RATING_CONFIRM_KEY, { [symbol]: value });
    p.expire(RATING_CONFIRM_KEY, TTL_SECONDS);
    await p.exec();
    if (lastWritten.size > 3000) lastWritten.clear();
    lastWritten.set(symbol, value);
    baseMemo.set(`${symbol}|${cur.day}`, base);
  } catch {
    // fail open
  }
}
