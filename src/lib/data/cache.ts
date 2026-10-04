import { after } from "next/server";
import { kvEnabled, redis } from "./kv";

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  /** 只有開了 staleWhileRevalidateMs 的 key 才有：過了 expiresAt 之後、這個時間點
   *  之前，值仍可當「舊資料」先回給訪客（同時背景重算）。沒有這個欄位＝傳統條目，
   *  行為跟加入 SWR 之前逐字相同。 */
  staleUntil?: number;
}

/** 條目真正可以從記憶體丟掉的時間：傳統條目＝expiresAt；SWR 條目＝寬限期結束。 */
function retainUntil(entry: CacheEntry): number {
  return entry.staleUntil !== undefined && entry.staleUntil > entry.expiresAt ? entry.staleUntil : entry.expiresAt;
}

// Process-local TTL cache — the fallback used whenever Redis (see ./kv)
// isn't configured, and also what a single request falls back to if a
// configured Redis is temporarily unreachable. Not shared across Vercel's
// serverless instances, but keeps the app fully functional without any
// external service.
const memoryStore = new Map<string, CacheEntry>();

// Cache keys are partly visitor-driven — /stock/<anything> becomes
// `quote:TW:<anything>`, and a null result is cached just like a real one —
// so an unbounded Map lets a crawler (or a bad link) grow a warm serverless
// instance until it runs out of memory. Expired entries are swept first;
// if that still isn't enough, the oldest-inserted keys go (a Map iterates in
// insertion order).
const MAX_MEMORY_ENTRIES = 500;

function readMemory(key: string): { hit: boolean; value: unknown } {
  const entry = memoryStore.get(key);
  if (!entry) return { hit: false, value: undefined };
  if (entry.expiresAt <= Date.now()) {
    // SWR 條目過期後在寬限期內要留著給 readMemoryWithStaleness() 當舊資料用；
    // 傳統條目（沒有 staleUntil）照舊直接刪掉。
    if (retainUntil(entry) <= Date.now()) memoryStore.delete(key);
    return { hit: false, value: undefined };
  }
  return { hit: true, value: entry.value };
}

type MemoryLookup = { state: "fresh" | "stale"; value: unknown } | { state: "miss" };

/** SWR 專用的記憶體讀取：分得出「新鮮」「過期但還在寬限期內」「沒有」三種。 */
function readMemoryWithStaleness(key: string): MemoryLookup {
  const entry = memoryStore.get(key);
  if (!entry) return { state: "miss" };
  const now = Date.now();
  if (entry.expiresAt > now) return { state: "fresh", value: entry.value };
  if (retainUntil(entry) > now) return { state: "stale", value: entry.value };
  memoryStore.delete(key);
  return { state: "miss" };
}

/** 以絕對時間寫入 SWR 條目（從 Redis 回填時，保留共用快取上真正剩下的新鮮期／寬限期）。 */
function writeMemoryEntry(key: string, value: unknown, expiresAt: number, staleUntil: number): void {
  memoryStore.set(key, { value, expiresAt, staleUntil });
  if (memoryStore.size > MAX_MEMORY_ENTRIES) evictMemory();
}

function writeMemory(key: string, value: unknown, ttlMs: number): void {
  // Expiry counts from *now* — the moment the value actually exists — and
  // deliberately not from before load() started. Measuring from before means
  // a load that takes n ms burns n ms of its own TTL, and a load slower than
  // its own TTL (a 20s quote TTL vs. a TWSE batch fetch that crawls when the
  // upstream is busy) is written already expired: the cache then silently
  // never hits and every single request re-fetches, which is exactly the
  // death spiral this cache exists to prevent.
  memoryStore.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (memoryStore.size > MAX_MEMORY_ENTRIES) evictMemory();
}

function evictMemory(): void {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (retainUntil(entry) <= now) memoryStore.delete(key);
  }
  for (const key of memoryStore.keys()) {
    if (memoryStore.size <= MAX_MEMORY_ENTRIES) break;
    memoryStore.delete(key);
  }
}

/**
 * Redis holds JSON, and JSON has no way to distinguish "this key holds null"
 * from "this key isn't set" — so values are wrapped before being stored.
 * Without the wrapper a cached null reads back as a miss, and null is
 * precisely what getQuote()/getChart() return when a source is unreachable:
 * the symbols that are already failing would be the ones re-fetched on every
 * single request. The wrapper also makes a pre-existing (unwrapped) entry
 * read as a miss, so an old-format key just gets recomputed once.
 */
interface CacheEnvelope {
  /** the cached value */
  v: unknown;
  /** epoch ms this value expires at, so an instance that reads it from the
   *  shared cache keeps its own copy only for the time that's actually left
   *  rather than restarting the TTL and serving it for up to twice as long */
  e: number;
  /** SWR 條目才有：寫入時間（epoch ms），方便判讀新鮮度／除錯 */
  w?: number;
  /** SWR 條目才有：可當舊資料回傳到這個時間點（epoch ms）為止；Redis 的 key
   *  實際存活時間也延長到這裡。傳統條目沒有這個欄位。 */
  s?: number;
}

function isEnvelope(value: unknown): value is CacheEnvelope {
  return typeof value === "object" && value !== null && "v" in value && "e" in value;
}

// In-flight request de-duplication ("single-flight"): a Next.js page like
// the homepage fires off several `cached()` calls for the *same* key
// (e.g. the daily brief and the homepage movers both ask for TW quotes)
// essentially simultaneously. Without this, every one of them sees a cache
// miss at the same instant — since none has written a result yet — and
// each independently kicks off its own full TWSE/Yahoo fetch. For the TW
// universe that meant a single page load could fire the *entire* batched
// quote fetch 4-6x over, multiplying both latency (the page waits on the
// slowest of many redundant fetches) and outbound request volume (raising
// the odds of getting rate-limited) by that same factor. Concurrent callers
// for the same key now share one in-flight promise instead.
//
// Consequence worth knowing: a load() must never await cached() on its own
// key, since it would then be waiting on itself. Nothing does today — the
// nesting that exists (momentum -> market quotes -> universe) is strictly
// between different keys.
const inFlight = new Map<string, Promise<unknown>>();

/**
 * TTL cache shared across serverless instances via Redis when configured
 * (see ./kv), otherwise a per-instance in-memory Map. Either backend fails
 * open: a Redis read/write error falls through to the in-memory copy and to
 * recomputing the value via `load()` rather than surfacing an error, since a
 * cache is never allowed to be the reason a page breaks.
 *
 * Values must survive a JSON round-trip, because that is what the Redis
 * backend does to them. Anything with behaviour attached — a Map, a Set, a
 * Date, a class instance — does not: use `cachedMap` for maps, and plain
 * objects/arrays/strings/numbers for everything else.
 *
 * Callers sharing a key must also agree on the value's shape: the returned
 * `T` is an unchecked assertion on both the in-flight promise and whatever
 * came back from Redis, so a key used with two different types would hand
 * one caller the other's value with no compile-time or runtime complaint.
 */
export interface CachedOptions {
  /** Skip both the memory and Redis read and recompute unconditionally —
   *  still writes the fresh result over whatever was cached. For manually
   *  clearing out a bad cached value (e.g. a truncated AI response) without
   *  waiting out its TTL, rather than a knob callers reach for routinely. */
  forceRefresh?: boolean;
  /**
   * 「過期先回舊資料、背景更新」（stale-while-revalidate）的寬限期（毫秒）。
   * 值超過 TTL 但還在這段寬限期內時，**立刻回傳舊值**，同時在背景重算一次
   * （見 refreshInBackground：同 key 單飛、跨 instance 用 Redis 鎖、用 Next 的
   * after() 讓回應送出後重算仍能跑完）。超過寬限期才會讓訪客現場等重算。
   * 不傳（或 0）＝傳統行為，跟加入這個選項之前逐字相同。
   *
   * 同一個 key 的所有呼叫端必須用同一種模式（都開或都不開）：傳統路徑讀到
   * SWR 條目的過期值時會當成 miss 重算，並用傳統格式覆蓋，寬限期就沒了。
   */
  staleWhileRevalidateMs?: number;
  /**
   * 只在開了 staleWhileRevalidateMs 時有意義：遇到過期值時，先等背景重算最多
   * 這麼久——來得及就直接回新值，來不及才回舊值（重算照樣在背景跑完）。
   * 即時報價類用：上游快的時候訪客拿到的仍是最新數字（不會因為 SWR 每一輪輪詢
   * 都晚一拍），上游慢的時候訪客也頂多多等這段時間。不傳＝0＝立刻回舊值。
   */
  revalidateWaitMs?: number;
}

export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>, opts: CachedOptions = {}): Promise<T> {
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  // Deferred by a microtask so the map entry is registered *before* any of
  // the work begins. runCached() is an async function, so calling it
  // directly would run it (and, on the memory-only path, load() itself)
  // synchronously up to its first await — i.e. before inFlight.set() below
  // — leaving a window in which a re-entrant call still saw a miss.
  const swrMs = opts.staleWhileRevalidateMs ?? 0;
  const promise = Promise.resolve()
    .then(() =>
      swrMs > 0
        ? readThroughSwr<T>(key, swrMs, load, {
            ttlFor: () => ttlMs,
            forceRefresh: opts.forceRefresh,
            revalidateWaitMs: opts.revalidateWaitMs,
          })
        : runCached<T>(key, ttlMs, load, opts)
    )
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

/**
 * `cached()` for a Map-valued loader. A Map cannot go through `cached()`
 * directly: JSON.stringify(new Map([...])) is "{}", so with Redis configured
 * the first request returns the real Map while storing an empty object, and
 * every later request inside the TTL reads back a plain `{}` with no `.get`,
 * no `.has` and no iterator — which throws in every caller that treats it as
 * a Map. The entry list is cached instead, and a fresh Map is rebuilt per
 * caller (which also stops concurrent callers from sharing one mutable Map).
 */
export async function cachedMap<K, V>(
  key: string,
  ttlMs: number,
  load: () => Promise<Map<K, V>>,
  opts: CachedOptions = {}
): Promise<Map<K, V>> {
  const entries = await cached<Array<[K, V]>>(key, ttlMs, async () => Array.from(await load()), opts);
  return new Map(entries);
}

async function runCached<T>(key: string, ttlMs: number, load: () => Promise<T>, opts: CachedOptions = {}): Promise<T> {
  if (opts.forceRefresh) {
    const value = await load();
    writeMemory(key, value, ttlMs);
    if (kvEnabled && redis) await writeRedis(key, value, ttlMs);
    return value;
  }

  const local = readMemory(key);
  if (local.hit) return local.value as T;

  if (kvEnabled && redis) {
    try {
      const hit = await redis.get<CacheEnvelope>(key);
      // SWR 條目（有 s 欄位）在 Redis 裡會活到寬限期結束；傳統路徑不回舊資料，
      // 所以它過了新鮮期就當 miss。傳統條目沒有 s，這個判斷對它們永遠不成立。
      if (isEnvelope(hit) && !(hit.s !== undefined && hit.e <= Date.now())) {
        const remainingMs = hit.e - Date.now();
        if (remainingMs > 0) writeMemory(key, hit.v, remainingMs);
        return hit.v as T;
      }
    } catch {
      // Redis unreachable; fall through to computing a fresh value below
    }
  }

  const value = await load();
  // Written unconditionally: this is the only cache when Redis isn't
  // configured, and the safety net that stops every request re-fetching
  // upstream while a configured Redis is unreachable or rate-limited.
  writeMemory(key, value, ttlMs);
  if (kvEnabled && redis) await writeRedis(key, value, ttlMs);
  return value;
}

async function writeRedis(key: string, value: unknown, ttlMs: number): Promise<void> {
  if (!redis) return;
  if (value instanceof Map || value instanceof Set) {
    // Would silently round-trip to {} — see cachedMap. Loud in the log and
    // degraded to the in-memory cache, rather than quietly corrupt.
    console.error(`[cache] not storing a ${value.constructor.name} in Redis for key "${key}" — JSON can't represent it; use cachedMap`);
    return;
  }
  try {
    await redis.set(key, { v: value, e: Date.now() + ttlMs } satisfies CacheEnvelope, {
      ex: Math.max(1, Math.round(ttlMs / 1000)),
    });
  } catch {
    // best-effort; a shared-cache write failure shouldn't break the response
  }
}

// ── 過期先回舊資料、背景更新（stale-while-revalidate）──────────────────────
//
// 2026-10-04 使用者要求：「快取過期後的第一位訪客要現場抓整個市場報價／現場等
// AI 重算，這樣不行」。開了 staleWhileRevalidateMs 的 key：
//  - 新鮮 → 直接回傳（跟傳統一樣）
//  - 過期但在寬限期內 → **立刻回傳舊值**，背景重算一次寫回記憶體＋Redis
//  - 超過寬限期／從來沒算過 → 跟傳統一樣現場算
// 背景重算的保護：
//  - 同一個 instance 同一個 key 只會有一個背景重算（backgroundRefreshes）
//  - 跨 instance 先看 Redis 是不是別人已經更新好了，再用 Redis 鎖（SET NX PX）
//    確保同一時間只有一個 instance 在重算——AI 快報這類重算很貴（AI 額度＋CPU）
//  - 失敗（拋錯）不覆蓋舊值，退避一段時間才再試，避免上游掛掉時每個請求都重打
//  - 算出「降級」結果（呼叫端用 isDegraded 判斷，例如 null／空清單／筆數過少）
//    時也不覆蓋手上還能用的舊好值——延續「失敗不當成正常結果放大」的設計
//  - Vercel serverless 回應送出後背景工作會被凍結，所以用 Next 官方的 after()
//    （底層是 Vercel 的 waitUntil）讓重算在回應送出後仍能跑完；在 Next 請求範圍
//    外（例如 node 腳本）呼叫時 after() 會拋錯，此時就只是一般的背景 promise。

export interface SwrPolicy<S> {
  /** 剛算出來的值要給多長的新鮮 TTL（降級值通常給較短的 TTL）。 */
  ttlFor: (value: S) => number;
  /** 這個值算不算降級（null／空／殘缺）。降級值不給寬限期——過期就是真的 miss，
   *  跟傳統「降級短 TTL」行為一致；背景重算得到降級值時也不覆蓋舊的好值。 */
  isDegraded?: (value: S) => boolean;
  /** 跳過讀取直接重算並寫入（同 CachedOptions.forceRefresh）。 */
  forceRefresh?: boolean;
  /** 同 CachedOptions.revalidateWaitMs。 */
  revalidateWaitMs?: number;
}

/** 同 key 跨 instance 重算鎖的存活上限：最慢的背景重算（AI 快報、全市場技術
 *  篩選）也在這之內；instance 中途被凍結時鎖會自己過期，不會永久卡住。 */
const SWR_LOCK_MS = 90_000;
/** 別的 instance 正在重算時，這個 instance 多久之後才會再嘗試。 */
const SWR_LOCK_BUSY_BACKOFF_MS = 10_000;
/** 背景重算拋錯後的退避時間：TTL 跟 60 秒取小、但至少 5 秒。 */
function swrFailureBackoffMs(ttlMs: number): number {
  return Math.max(5_000, Math.min(ttlMs, 60_000));
}

const backgroundRefreshes = new Map<string, Promise<unknown>>();
const refreshBackoffUntil = new Map<string, number>();

/**
 * SWR 讀取核心。`cached()`（開了 staleWhileRevalidateMs）與 degradedCache.ts 的
 * 各種降級變體共用這一份，各自只決定 TTL／降級判斷。本身不做同 key 去重——呼叫端
 * 自己包單飛（cached() 已有 inFlight）。
 */
export async function readThroughSwr<S>(
  key: string,
  swrMs: number,
  load: () => Promise<S>,
  policy: SwrPolicy<S>
): Promise<S> {
  if (policy.forceRefresh) return loadAndStoreSwr(key, swrMs, load, policy);

  const local = readMemoryWithStaleness(key);
  if (local.state === "fresh") return local.value as S;
  if (local.state === "stale") return serveStale(key, swrMs, load, policy, local.value as S);

  if (kvEnabled && redis) {
    try {
      const hit = await redis.get<CacheEnvelope>(key);
      if (isEnvelope(hit)) {
        const now = Date.now();
        const staleUntil = hit.s ?? hit.e;
        if (hit.e > now) {
          writeMemoryEntry(key, hit.v, hit.e, staleUntil);
          return hit.v as S;
        }
        if (staleUntil > now) {
          writeMemoryEntry(key, hit.v, hit.e, staleUntil);
          return serveStale(key, swrMs, load, policy, hit.v as S);
        }
      }
    } catch {
      // Redis unreachable; fall through to computing a fresh value below
    }
  }

  return loadAndStoreSwr(key, swrMs, load, policy);
}

async function loadAndStoreSwr<S>(key: string, swrMs: number, load: () => Promise<S>, policy: SwrPolicy<S>): Promise<S> {
  const value = await load();
  await storeSwr(key, value, swrMs, policy);
  return value;
}

async function storeSwr<S>(key: string, value: S, swrMs: number, policy: SwrPolicy<S>): Promise<void> {
  const now = Date.now();
  const expiresAt = now + policy.ttlFor(value);
  const staleUntil = expiresAt + (policy.isDegraded?.(value) ? 0 : swrMs);
  writeMemoryEntry(key, value, expiresAt, staleUntil);
  if (!(kvEnabled && redis)) return;
  if (value instanceof Map || value instanceof Set) {
    console.error(`[cache] not storing a ${value.constructor.name} in Redis for key "${key}" — JSON can't represent it; use cachedMap`);
    return;
  }
  try {
    await redis.set(key, { v: value, e: expiresAt, w: now, s: staleUntil } satisfies CacheEnvelope, {
      ex: Math.max(1, Math.round((staleUntil - now) / 1000)),
    });
  } catch {
    // best-effort; a shared-cache write failure shouldn't break the response
  }
}

/** 過期值的處理：觸發背景重算；有設 revalidateWaitMs 就先等它一下，來得及回新值。 */
async function serveStale<S>(key: string, swrMs: number, load: () => Promise<S>, policy: SwrPolicy<S>, staleValue: S): Promise<S> {
  const task = refreshInBackground(key, swrMs, load, policy, staleValue);
  const waitMs = policy.revalidateWaitMs ?? 0;
  if (!task || waitMs <= 0) return staleValue;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), waitMs);
  });
  try {
    const fresh = await Promise.race([task, timeout]);
    return fresh === undefined ? staleValue : fresh.value;
  } finally {
    clearTimeout(timer);
  }
}

/** 回傳背景重算的 promise（成功拿到可用新值時 resolve 成 { value }，其餘
 *  resolve 成 undefined、永不 reject）；退避中則回 undefined、不重算。 */
function refreshInBackground<S>(
  key: string,
  swrMs: number,
  load: () => Promise<S>,
  policy: SwrPolicy<S>,
  staleValue: S
): Promise<{ value: S } | undefined> | undefined {
  const existing = backgroundRefreshes.get(key);
  if (existing) return existing as Promise<{ value: S } | undefined>;
  const backoff = refreshBackoffUntil.get(key);
  if (backoff !== undefined && backoff > Date.now()) return undefined;
  const task = runBackgroundRefresh(key, swrMs, load, policy, staleValue).finally(() => {
    backgroundRefreshes.delete(key);
  });
  backgroundRefreshes.set(key, task);
  keepAliveAfterResponse(task);
  return task;
}

async function runBackgroundRefresh<S>(
  key: string,
  swrMs: number,
  load: () => Promise<S>,
  policy: SwrPolicy<S>,
  staleValue: S
): Promise<{ value: S } | undefined> {
  const lockKey = `swr-lock:${key}`;
  let locked = false;
  if (kvEnabled && redis) {
    try {
      // 別的 instance 可能剛更新好（這邊只是記憶體裡還留著舊值）：直接沿用，不重算。
      const current = await redis.get<CacheEnvelope>(key);
      if (isEnvelope(current) && current.e > Date.now()) {
        writeMemoryEntry(key, current.v, current.e, current.s ?? current.e);
        return { value: current.v as S };
      }
      const acquired = await redis.set(lockKey, Date.now(), { nx: true, px: SWR_LOCK_MS });
      if (acquired === null) {
        refreshBackoffUntil.set(key, Date.now() + SWR_LOCK_BUSY_BACKOFF_MS);
        return undefined;
      }
      locked = true;
    } catch {
      // Redis 暫時不通：照樣在這個 instance 重算（fail open）
    }
  }
  try {
    const value = await load();
    if (policy.isDegraded?.(value) && !policy.isDegraded(staleValue)) {
      // 降級結果不蓋掉還能用的舊好值；等降級 TTL 過了再試（跟傳統路徑的重試節奏一樣）。
      refreshBackoffUntil.set(key, Date.now() + policy.ttlFor(value));
      return undefined;
    }
    await storeSwr(key, value, swrMs, policy);
    refreshBackoffUntil.delete(key);
    return { value };
  } catch (err) {
    refreshBackoffUntil.set(key, Date.now() + swrFailureBackoffMs(policy.ttlFor(staleValue)));
    console.error(`[cache] background refresh failed for "${key}" (still serving the stale value):`, err);
    return undefined;
  } finally {
    if (locked && redis) await redis.del(lockKey).catch(() => undefined);
  }
}

/** 讓回應送出後背景工作仍能跑完（Vercel：waitUntil）。不在 Next 請求範圍內時
 *  after() 會拋錯，此時 promise 本來就會自己跑完（例如本機腳本），忽略即可。 */
function keepAliveAfterResponse(task: Promise<unknown>): void {
  try {
    after(task);
  } catch {
    // outside a Next request scope — nothing to extend
  }
}

/**
 * Reads a cache entry without computing or writing anything on a miss —
 * `cached()` can't do this on its own since it always calls `load()` and
 * writes the result when the key isn't present. Needed for a "check which
 * of these N keys are already cached, then make one batched call to fill in
 * only the missing ones" pattern (e.g. per-news-item AI summaries: caching
 * a `load()` that returns null on miss would permanently cache "no summary"
 * for that item, never batching it).
 */
export async function peekCached<T>(key: string): Promise<T | undefined> {
  const local = readMemory(key);
  if (local.hit) return local.value as T;
  if (kvEnabled && redis) {
    try {
      const hit = await redis.get<CacheEnvelope>(key);
      if (isEnvelope(hit) && hit.e > Date.now()) {
        // Backfilled into the in-memory copy for whatever TTL is actually
        // left, exactly as runCached() already does on a Redis hit — without
        // this, every caller of a peek-based cache pays a Redis round trip on
        // *every* request instead of only after its TTL runs out. That was
        // tolerable for the original peek callers (the whole-market universe,
        // per-news-item summaries), but not once `/api/indices` started using
        // this path (5 index keys × every homepage render and every poll).
        writeMemory(key, hit.v, hit.e - Date.now());
        return hit.v as T;
      }
    } catch {
      // Redis unreachable; treat as a miss
    }
  }
  return undefined;
}

/** Writes a value directly into the cache (memory + Redis), independent of
 *  the read-or-compute flow `cached()` provides — the write half of the
 *  "batch-fill only what peekCached() found missing" pattern above. */
export async function writeCached<T>(key: string, value: T, ttlMs: number): Promise<void> {
  writeMemory(key, value, ttlMs);
  if (kvEnabled && redis) await writeRedis(key, value, ttlMs);
}

/** Splits an array into fixed-size groups — used to keep batch-quote request
 * URLs/payloads a safe size once the stock universe grew well past a
 * couple dozen symbols. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Promise.all over a list, but with at most `limit` workers running at a
 * time — the same reason the batch-quote fetches exist. A plain
 * `Promise.all(candidates.map(getChart))` fans out per candidate, and each
 * TW chart fetch itself fans out per calendar month, so a 25-candidate
 * screen fired ~100 simultaneous requests at TWSE. That is exactly the
 * burst that gets the whole site throttled — including the single-stock
 * lookups that have nothing to do with this screen. Results stay in input
 * order so callers can still pair them up with their inputs.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Several callers (Gemini, in particular) put an API key directly in the
 * query string (`?key=...`). On a non-2xx response the error below used to
 * embed the *full* URL verbatim — and that error's message eventually
 * reaches the client as-is (via provider.ts's failure log -> ask.ts's
 * canned fallback answer) whenever every AI provider fails, which put a
 * live, working API key in a chat bubble in the browser the first time
 * Gemini returned a 429. Redacting known secret-bearing params here fixes
 * every current and future caller at once, not just Gemini's call sites.
 */
function redactSecretParams(url: string): string {
  try {
    const parsed = new URL(url);
    for (const param of ["key", "apikey", "api_key", "token", "secret"]) {
      if (parsed.searchParams.has(param)) parsed.searchParams.set(param, "***");
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export async function fetchWithTimeout(url: string, timeoutMs = 4000, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} for ${redactSecretParams(url)}${body ? `: ${body.slice(0, 500)}` : ""}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}
