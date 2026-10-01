import { kvEnabled, redis } from "./kv";

/**
 * Adanos（社群情緒 API）用量護欄。免費方案「每個帳單週期 250 次」，超用就整個月沒得用，
 * 所以每一次真正打上游之前都必須先過 `reserveAdanosCall()`，而且要「先佔名額、再呼叫」
 * （INCR 是原子操作，多個 Vercel serverless 實例同時搶也不會超過上限）。
 *
 * 三層防線，任何一層不通過就不呼叫：
 *  1. 伺服器回報的真實剩餘額度（`x-ratelimit-remaining-monthly`／`reset-monthly`）：
 *     2026-10-01 實測 Adanos 的月額度是「依註冊日起算的週期」（當時重置時間是每月22日
 *     14:15 UTC），不是日曆月——光靠自己「每月1號歸零」的計數器會跟真實週期錯開而超用，
 *     所以以伺服器回報為準：剩餘 ≤ SERVER_REMAINING_FLOOR 就停到重置時間為止。
 *  2. 自己的月計數（UTC 日曆月 key，INCR）：上限 MONTHLY_CAP，萬一上游沒回 header 時的保底。
 *  3. 自己的日計數（紐約日期 key，INCR）：上限 DAILY_CAP。
 *
 * 沒有 Redis 時計數器無法跨實例共用：正式環境一律拒絕呼叫（fail closed），只有本機開發
 * （呼叫端另外要求 ADANOS_ALLOW_LOCAL=1）才退回單一行程的記憶體計數。Redis 讀寫失敗也一律拒絕。
 */

/** 自己的月計數上限（250 減安全邊際） */
export const MONTHLY_CAP = 240;
/** 自己的日計數上限（正常節奏約 10 次/天） */
export const DAILY_CAP = 12;
/** 伺服器回報的剩餘額度低於等於這個數就停止呼叫 */
export const SERVER_REMAINING_FLOOR = 10;

const QUOTA_KEY = "adanos:quota";

interface ServerQuota {
  remaining: number;
  /** epoch ms，帳單週期重置時間 */
  resetAt: number;
}

const memCounters = new Map<string, number>();
let memQuota: ServerQuota | null = null;

function utcMonthKey(now: Date): string {
  return `adanos:calls:month:${now.toISOString().slice(0, 7)}`;
}

function nyDayKey(now: Date): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now); // YYYY-MM-DD
  return `adanos:calls:day:${day}`;
}

async function readServerQuota(): Promise<ServerQuota | null> {
  if (!kvEnabled || !redis) return memQuota;
  return (await redis.get<ServerQuota>(QUOTA_KEY)) ?? null;
}

async function incr(key: string, ttlSec: number): Promise<number> {
  if (!kvEnabled || !redis) {
    const n = (memCounters.get(key) ?? 0) + 1;
    memCounters.set(key, n);
    return n;
  }
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, ttlSec);
  return n;
}

export type ReserveResult = { ok: true } | { ok: false; reason: string };

/** 判斷能不能再打一次 Adanos；可以的話「已經」把這次算進日/月計數。 */
export async function reserveAdanosCall(now: Date = new Date()): Promise<ReserveResult> {
  try {
    const q = await readServerQuota();
    if (q && q.resetAt > now.getTime() && q.remaining <= SERVER_REMAINING_FLOOR) {
      return { ok: false, reason: `server-remaining-${q.remaining}` };
    }
    const day = await incr(nyDayKey(now), 2 * 86400);
    if (day > DAILY_CAP) return { ok: false, reason: `daily-cap-${day - 1}` };
    const month = await incr(utcMonthKey(now), 40 * 86400);
    if (month > MONTHLY_CAP) return { ok: false, reason: `monthly-cap-${month - 1}` };
    return { ok: true };
  } catch {
    return { ok: false, reason: "redis-error" };
  }
}

/** 每次拿到上游回應（不論成功與否）就記下伺服器回報的剩餘額度。 */
export async function recordServerQuota(headers: Headers, status: number, now: Date = new Date()): Promise<void> {
  const remainingRaw = headers.get("x-ratelimit-remaining-monthly");
  const resetRaw = headers.get("x-ratelimit-reset-monthly");
  let remaining = remainingRaw != null ? Number(remainingRaw) : NaN;
  let resetAt = resetRaw ? Date.parse(resetRaw) : NaN;
  if (status === 429) {
    // 額度用完／被限流：至少停到重置時間（不知道的話停 24 小時）
    remaining = 0;
    if (!Number.isFinite(resetAt) || resetAt <= now.getTime()) resetAt = now.getTime() + 86400_000;
  }
  if (!Number.isFinite(remaining) || !Number.isFinite(resetAt)) return;
  const q: ServerQuota = { remaining, resetAt };
  if (!kvEnabled || !redis) {
    memQuota = q;
    return;
  }
  try {
    const ttlSec = Math.max(60, Math.ceil((resetAt - now.getTime()) / 1000));
    await redis.set(QUOTA_KEY, q, { ex: ttlSec });
  } catch {
    // 寫不進去就算了：下次 reserve 時讀 Redis 失敗會 fail closed
  }
}

/** 給測試/除錯用：目前的用量狀態（不含金鑰） */
export async function getAdanosUsage(now: Date = new Date()): Promise<{ day: number; month: number; server: ServerQuota | null }> {
  if (!kvEnabled || !redis) {
    return { day: memCounters.get(nyDayKey(now)) ?? 0, month: memCounters.get(utcMonthKey(now)) ?? 0, server: memQuota };
  }
  const [day, month, server] = await Promise.all([
    redis.get<number>(nyDayKey(now)),
    redis.get<number>(utcMonthKey(now)),
    readServerQuota(),
  ]);
  return { day: Number(day ?? 0), month: Number(month ?? 0), server };
}
