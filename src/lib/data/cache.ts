import { kvEnabled, redis } from "./kv";

interface CacheEntry {
  value: unknown;
  expiresAt: number;
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
    memoryStore.delete(key);
    return { hit: false, value: undefined };
  }
  return { hit: true, value: entry.value };
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
    if (entry.expiresAt <= now) memoryStore.delete(key);
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
}

export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>, opts: CachedOptions = {}): Promise<T> {
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  // Deferred by a microtask so the map entry is registered *before* any of
  // the work begins. runCached() is an async function, so calling it
  // directly would run it (and, on the memory-only path, load() itself)
  // synchronously up to its first await — i.e. before inFlight.set() below
  // — leaving a window in which a re-entrant call still saw a miss.
  const promise = Promise.resolve()
    .then(() => runCached<T>(key, ttlMs, load, opts))
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
  load: () => Promise<Map<K, V>>
): Promise<Map<K, V>> {
  const entries = await cached<Array<[K, V]>>(key, ttlMs, async () => Array.from(await load()));
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
      if (isEnvelope(hit)) {
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
