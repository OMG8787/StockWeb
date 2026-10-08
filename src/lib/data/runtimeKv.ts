import { getCache, type RuntimeCache } from "@vercel/functions";

/**
 * 用 Vercel Runtime Cache 模擬本站用到的 Redis 指令（2026-10-08 使用者決定不用 Redis）。
 * Runtime Cache 所有方案（含免費 Hobby）都有、所有伺服器實例共用、單筆上限 2 MB，
 * 但它是「快取」：可能被淘汰、不保證永久保存——所以只適合速度快取、計數器、鎖；
 * 需要永久保存的紀錄另外寫進 Google 試算表（見各模組）。
 *
 * 行為與 Upstash Redis 對齊的地方：
 * - get 讀到 JSON 字串會自動解析（Upstash 預設 automaticDeserialization，既有程式依賴這點）。
 * - set 支援 ex／px（秒／毫秒到期）與 nx（不存在才寫，回 "OK" 或 null）。
 * - hash／list／set 整包存成一筆（讀出、改、寫回）；不是原子操作，但本站同時寫入的量很小。
 */

interface Entry {
  v: unknown;
  /** 到期時間（毫秒）；null＝不過期 */
  x: number | null;
}

/** 沒有設到期時間的鍵也給一個上限，避免永遠占空間（反正快取隨時可能被淘汰） */
const DEFAULT_TTL_SEC = 30 * 86_400;

type SetOpts = { ex?: number; px?: number; nx?: boolean };

function autoParse(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("[") || /^-?\d+(\.\d+)?$/.test(t) || t === "true" || t === "false" || t === "null")) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

export class RuntimeKv {
  constructor(private cache: RuntimeCache = getCache({ namespace: "stockweb" })) {}

  protected async read(key: string): Promise<Entry | null> {
    const e = (await this.cache.get(key)) as Entry | null;
    if (!e || typeof e !== "object" || !("v" in e)) return null;
    if (e.x != null && e.x <= Date.now()) return null;
    return e;
  }

  protected async write(key: string, v: unknown, expiresAt: number | null): Promise<void> {
    const ttl = expiresAt == null ? DEFAULT_TTL_SEC : Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
    await this.cache.set(key, { v, x: expiresAt } satisfies Entry, { ttl, name: "" });
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const e = await this.read(key);
    return e ? (autoParse(e.v) as T) : null;
  }

  async set(key: string, value: unknown, opts: SetOpts = {}): Promise<"OK" | null> {
    if (opts.nx && (await this.read(key))) return null;
    const ms = opts.px ?? (opts.ex != null ? opts.ex * 1000 : null);
    await this.write(key, value, ms == null ? null : Date.now() + ms);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    await Promise.all(keys.map((k) => this.cache.delete(k)));
    return keys.length;
  }

  async mget<T extends unknown[] = unknown[]>(...keys: string[]): Promise<T> {
    return (await Promise.all(keys.map((k) => this.get(k)))) as T;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const e = await this.read(key);
    if (!e) return 0;
    await this.write(key, e.v, Date.now() + seconds * 1000);
    return 1;
  }

  async incr(key: string): Promise<number> {
    return this.incrby(key, 1);
  }

  async decr(key: string): Promise<number> {
    return this.incrby(key, -1);
  }

  async incrby(key: string, n: number): Promise<number> {
    const e = await this.read(key);
    const next = (Number(e?.v) || 0) + n;
    await this.write(key, next, e?.x ?? null);
    return next;
  }

  // ---------- hash（整包存成一個物件） ----------
  private async hash(key: string): Promise<{ h: Record<string, unknown>; x: number | null }> {
    const e = await this.read(key);
    return { h: e && e.v && typeof e.v === "object" ? { ...(e.v as Record<string, unknown>) } : {}, x: e?.x ?? null };
  }

  async hget<T = unknown>(key: string, field: string): Promise<T | null> {
    const { h } = await this.hash(key);
    return field in h ? (autoParse(h[field]) as T) : null;
  }

  async hmget<T = unknown>(key: string, ...fields: string[]): Promise<Array<T | null>> {
    const { h } = await this.hash(key);
    return fields.map((f) => (f in h ? (autoParse(h[f]) as T) : null));
  }

  async hset(key: string, values: Record<string, unknown>): Promise<number> {
    const { h, x } = await this.hash(key);
    const added = Object.keys(values).filter((k) => !(k in h)).length;
    await this.write(key, { ...h, ...values }, x);
    return added;
  }

  async hsetnx(key: string, field: string, value: unknown): Promise<number> {
    const { h, x } = await this.hash(key);
    if (field in h) return 0;
    h[field] = value;
    await this.write(key, h, x);
    return 1;
  }

  async hincrby(key: string, field: string, n: number): Promise<number> {
    const { h, x } = await this.hash(key);
    const next = (Number(h[field]) || 0) + n;
    h[field] = next;
    await this.write(key, h, x);
    return next;
  }

  async hgetall<T extends Record<string, unknown> = Record<string, unknown>>(key: string): Promise<T | null> {
    const { h } = await this.hash(key);
    if (Object.keys(h).length === 0) return null;
    return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, autoParse(v)])) as T;
  }

  // ---------- set／list ----------
  async sadd(key: string, ...members: unknown[]): Promise<number> {
    const e = await this.read(key);
    const cur = new Set((Array.isArray(e?.v) ? (e!.v as unknown[]) : []).map(String));
    const before = cur.size;
    members.forEach((m) => cur.add(String(m)));
    await this.write(key, [...cur], e?.x ?? null);
    return cur.size - before;
  }

  async smembers<T = string[]>(key: string): Promise<T> {
    const e = await this.read(key);
    return (Array.isArray(e?.v) ? e!.v : []) as T;
  }

  async rpush(key: string, ...values: unknown[]): Promise<number> {
    const e = await this.read(key);
    const list = Array.isArray(e?.v) ? [...(e!.v as unknown[])] : [];
    list.push(...values);
    await this.write(key, list, e?.x ?? null);
    return list.length;
  }

  async lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]> {
    const e = await this.read(key);
    const list = Array.isArray(e?.v) ? (e!.v as unknown[]) : [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start < 0 ? Math.max(0, list.length + start) : start, end).map(autoParse) as T[];
  }

  /** 依序執行的 pipeline（每個方法回傳自己可以串接；exec 回傳各指令結果） */
  pipeline(): KvPipeline {
    const queue: Array<() => Promise<unknown>> = [];
    const kv = this;
    const add =
      <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) =>
      (...a: A) => {
        queue.push(() => fn.apply(kv, a));
        return p;
      };
    const p: KvPipeline = {
      get: add(kv.get),
      set: add(kv.set),
      del: add(kv.del),
      expire: add(kv.expire),
      incr: add(kv.incr),
      hget: add(kv.hget),
      hmget: add(kv.hmget),
      hset: add(kv.hset),
      hsetnx: add(kv.hsetnx),
      hincrby: add(kv.hincrby),
      hgetall: add(kv.hgetall),
      sadd: add(kv.sadd),
      smembers: add(kv.smembers),
      rpush: add(kv.rpush),
      lrange: add(kv.lrange),
      async exec<T extends unknown[] = unknown[]>() {
        const out: unknown[] = [];
        for (const job of queue) out.push(await job());
        return out as T;
      },
    };
    return p;
  }
}

export interface KvPipeline {
  get(key: string): KvPipeline;
  set(key: string, value: unknown, opts?: SetOpts): KvPipeline;
  del(...keys: string[]): KvPipeline;
  expire(key: string, seconds: number): KvPipeline;
  incr(key: string): KvPipeline;
  hget(key: string, field: string): KvPipeline;
  hmget(key: string, ...fields: string[]): KvPipeline;
  hset(key: string, values: Record<string, unknown>): KvPipeline;
  hsetnx(key: string, field: string, value: unknown): KvPipeline;
  hincrby(key: string, field: string, n: number): KvPipeline;
  hgetall(key: string): KvPipeline;
  sadd(key: string, ...members: unknown[]): KvPipeline;
  smembers(key: string): KvPipeline;
  rpush(key: string, ...values: unknown[]): KvPipeline;
  lrange(key: string, start: number, stop: number): KvPipeline;
  exec<T extends unknown[] = unknown[]>(): Promise<T>;
}
