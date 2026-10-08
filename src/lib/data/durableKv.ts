import { waitUntil } from "@vercel/functions";
import { getStore, type Row, type StoreOp, type TableName } from "@/lib/auth/store";
import { RuntimeKv, type KvPipeline } from "./runtimeKv";

/**
 * 混合儲存（2026-10-08 使用者決定不用 Redis、紀錄要存試算表）：
 * 以 Vercel Runtime Cache 為快取（RuntimeKv），永久紀錄類的鍵同時存進 Google 試算表。
 *
 * - 寫入：先寫 Runtime Cache，再「背景」寫試算表（50 毫秒內的寫入合併成一次請求），不拖慢回應。
 * - 讀取：Runtime Cache 有就用；沒有（被淘汰、或新部署）就從試算表載回整個鍵再放進快取。
 *   寫入前也會先確保整個鍵已載入，避免只寫到局部、把其他欄位蓋掉。
 * - 試算表每個「欄位／清單元素」一列：ID、Key、Field、Part、Parts、Kind、Value、UpdatedAt。
 *   單一儲存格上限 5 萬字，太長的值切成多個 Part。
 * - 鎖、計數、執行標記（lock／done／tried）只放快取，不寫試算表。
 *
 * 各模組（ratingLog、learningStore、simPortfolio、briefArchive、modelStats、ratingConfirmStore…）
 * 照舊用 Redis 指令，不需要改程式。
 */

const DURABLE: Array<{ prefix: string; table: TableName; exclude?: RegExp }> = [
  { prefix: "rating-log:v1:", table: "RatingLog" },
  { prefix: "rating-confirm:v1", table: "RatingConfirm" },
  { prefix: "learning:v1:", table: "Learning", exclude: /^learning:v1:(lock|done:|tried:)/ },
  { prefix: "sim-portfolio:v1:", table: "SimPortfolio", exclude: /^sim-portfolio:v1:lock/ },
  { prefix: "brief-archive:v1:", table: "BriefArchive" },
  { prefix: "ai-model-stats:v1:", table: "ModelStats" },
  // 全市場每日成交量（近 20 個交易日），股票篩選的 5 日均量／當週／當月用；快取被清掉不用重新累積
  { prefix: "volume-history:", table: "VolumeHistory" },
];

export function durableTableOf(key: string): TableName | null {
  for (const d of DURABLE) {
    if (key.startsWith(d.prefix) && !(d.exclude && d.exclude.test(key))) return d.table;
  }
  return null;
}

const SEP = "§";
/** 單一儲存格上限 50,000 字，留點餘裕 */
const CHUNK = 45_000;
const LOADED_MARK_SEC = 6 * 3600;
const FLUSH_DELAY_MS = 50;

type Kind = "s" | "h" | "l";

const toText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function rowsFor(table: TableName, key: string, kind: Kind, field: string, value: unknown, now: string): Row[] {
  const text = toText(value);
  const parts = Math.max(1, Math.ceil(text.length / CHUNK));
  return Array.from({ length: parts }, (_, i) => ({
    ID: [key, field, i].join(SEP),
    Key: key,
    Field: field,
    Part: String(i),
    Parts: String(parts),
    Kind: kind,
    Value: text.slice(i * CHUNK, (i + 1) * CHUNK),
    UpdatedAt: now,
  }));
}

/** 試算表的列 → 每個鍵的內容（字串／hash 物件／清單） */
export function assemble(rows: Row[]): Map<string, { kind: Kind; value: unknown }> {
  const byField = new Map<string, Row[]>();
  for (const r of rows) {
    const id = `${r.Key}${SEP}${r.Field}`;
    byField.set(id, [...(byField.get(id) ?? []), r]);
  }
  const out = new Map<string, { kind: Kind; value: unknown }>();
  for (const parts of byField.values()) {
    const first = parts.find((p) => p.Part === "0");
    if (!first) continue;
    const n = Number(first.Parts) || 1;
    const sorted = parts.filter((p) => Number(p.Part) < n).sort((a, b) => Number(a.Part) - Number(b.Part));
    if (sorted.length < n) continue; // 切片不齊（寫到一半），略過
    const text = sorted.map((p) => p.Value).join("");
    const kind = (first.Kind as Kind) || "s";
    const cur = out.get(first.Key);
    if (kind === "s") out.set(first.Key, { kind, value: text });
    else if (kind === "h") {
      const h = (cur?.value as Record<string, string>) ?? {};
      h[first.Field] = text;
      out.set(first.Key, { kind, value: h });
    } else {
      const l = (cur?.value as Array<[string, string]>) ?? [];
      l.push([first.Field, text]);
      out.set(first.Key, { kind, value: l });
    }
  }
  // 清單依 Field（寫入時的遞增序號）排序後只留值
  for (const [k, v] of out) {
    if (v.kind === "l") out.set(k, { kind: "l", value: (v.value as Array<[string, string]>).sort((a, b) => a[0].localeCompare(b[0])).map((x) => x[1]) });
  }
  return out;
}

function background(p: Promise<unknown>) {
  const guarded = p.catch((err) => console.warn("[durable-kv] 寫入試算表失敗：", err));
  try {
    waitUntil(guarded);
  } catch {
    // 不在請求範圍內（例如測試）：讓它自己跑完
  }
}

let seq = 0;
const listField = () => `${Date.now().toString().padStart(14, "0")}-${(seq++ % 1e6).toString().padStart(6, "0")}`;

export class DurableKv extends RuntimeKv {
  private pending: StoreOp[] = [];
  private sheetDownUntil = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushDone: Promise<void> | null = null;

  // ---------- 載入 ----------
  private markKey = (key: string) => `${key}::loaded`;

  private async isLoaded(key: string): Promise<boolean> {
    return (await this.read(key)) != null || (await this.read(this.markKey(key))) != null;
  }

  /** 確保這些鍵已從試算表載入快取（一次請求讀多個鍵） */
  async ensureLoaded(keys: string[]): Promise<void> {
    const durable = [...new Set(keys)].filter((k) => durableTableOf(k));
    const missing: string[] = [];
    for (const k of durable) if (!(await this.isLoaded(k))) missing.push(k);
    if (missing.length === 0) return;
    const byTable = new Map<TableName, string[]>();
    for (const k of missing) byTable.set(durableTableOf(k)!, [...(byTable.get(durableTableOf(k)!) ?? []), k]);
    const tables = [...byTable.keys()];
    if (Date.now() < this.sheetDownUntil) return;
    let results: Row[][];
    try {
      results = (await getStore().batch(tables.map((table) => ({ op: "readKeys" as const, table, col: "Key", values: byTable.get(table)! })))) as Row[][];
    } catch (err) {
      // 試算表暫時讀不到（或 Apps Script 還是舊版）：先只用快取，1 分鐘內不再重試，不讓評等、問答跟著壞掉
      console.warn("[durable-kv] 從試算表載入失敗，先只用快取：", err);
      this.sheetDownUntil = Date.now() + 60_000;
      return;
    }
    const loaded = assemble(results.flat());
    for (const k of missing) {
      const hit = loaded.get(k);
      if (hit) await this.write(k, hit.value, null);
      await this.write(this.markKey(k), 1, Date.now() + LOADED_MARK_SEC * 1000);
    }
  }

  // ---------- 寫入試算表（合併、背景） ----------
  private queue(ops: StoreOp[]) {
    this.pending.push(...ops);
    if (this.flushTimer) return;
    let resolve!: () => void;
    this.flushDone = new Promise<void>((r) => (resolve = r));
    background(this.flushDone);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = this.pending;
      this.pending = [];
      // 照寫入順序送出（Apps Script 依序執行），「先寫再刪」不會被顛倒
      getStore()
        .batch(batch)
        .then(() => resolve())
        .catch((err) => {
          console.warn("[durable-kv] 寫入試算表失敗：", err);
          resolve();
        });
    }, FLUSH_DELAY_MS);
  }

  /** 測試用：等待背景寫入完成 */
  async flush(): Promise<void> {
    while (this.flushTimer || this.flushDone) {
      const p = this.flushDone;
      if (!p) break;
      await p;
      if (this.flushDone === p) this.flushDone = null;
    }
  }

  private mirror(key: string, kind: Kind, field: string, value: unknown) {
    const table = durableTableOf(key);
    if (!table) return;
    this.queue([{ op: "upsert", table, rows: rowsFor(table, key, kind, field, value, new Date().toISOString()) }]);
  }

  // ---------- 覆寫會讀寫永久鍵的指令 ----------
  override async get<T = unknown>(key: string): Promise<T | null> {
    await this.ensureLoaded([key]);
    return super.get<T>(key);
  }

  override async mget<T extends unknown[] = unknown[]>(...keys: string[]): Promise<T> {
    await this.ensureLoaded(keys);
    return super.mget<T>(...keys);
  }

  override async set(key: string, value: unknown, opts: { ex?: number; px?: number; nx?: boolean } = {}): Promise<"OK" | null> {
    if (opts.nx) await this.ensureLoaded([key]);
    const r = await super.set(key, value, opts);
    const table = durableTableOf(key);
    if (r === "OK" && table) {
      this.queue([
        { op: "deleteWhere", table, col: "Key", values: [key] },
        { op: "upsert", table, rows: rowsFor(table, key, "s", "", value, new Date().toISOString()) },
      ]);
    }
    return r;
  }

  override async del(...keys: string[]): Promise<number> {
    const n = await super.del(...keys);
    for (const k of keys) {
      const table = durableTableOf(k);
      if (table) this.queue([{ op: "deleteWhere", table, col: "Key", values: [k] }]);
    }
    return n;
  }

  override async hget<T = unknown>(key: string, field: string): Promise<T | null> {
    await this.ensureLoaded([key]);
    return super.hget<T>(key, field);
  }

  override async hmget<T = unknown>(key: string, ...fields: string[]): Promise<Array<T | null>> {
    await this.ensureLoaded([key]);
    return super.hmget<T>(key, ...fields);
  }

  override async hgetall<T extends Record<string, unknown> = Record<string, unknown>>(key: string): Promise<T | null> {
    await this.ensureLoaded([key]);
    return super.hgetall<T>(key);
  }

  override async hset(key: string, values: Record<string, unknown>): Promise<number> {
    await this.ensureLoaded([key]);
    const n = await super.hset(key, values);
    for (const [f, v] of Object.entries(values)) this.mirror(key, "h", f, v);
    return n;
  }

  override async hsetnx(key: string, field: string, value: unknown): Promise<number> {
    await this.ensureLoaded([key]);
    const n = await super.hsetnx(key, field, value);
    if (n === 1) this.mirror(key, "h", field, value);
    return n;
  }

  override async hincrby(key: string, field: string, n: number): Promise<number> {
    await this.ensureLoaded([key]);
    const next = await super.hincrby(key, field, n);
    this.mirror(key, "h", field, next);
    return next;
  }

  override async rpush(key: string, ...values: unknown[]): Promise<number> {
    await this.ensureLoaded([key]);
    const n = await super.rpush(key, ...values);
    for (const v of values) this.mirror(key, "l", listField(), v);
    return n;
  }

  override async lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]> {
    await this.ensureLoaded([key]);
    return super.lrange<T>(key, start, stop);
  }

  /** pipeline：先一次把用到的永久鍵全部載入，再依序執行（寫入會在背景合併成一次試算表請求） */
  override pipeline(): KvPipeline {
    const inner = super.pipeline();
    const keys: string[] = [];
    const wrap = new Proxy(inner, {
      get: (target, prop: string) => {
        if (prop === "exec") {
          return async () => {
            await this.ensureLoaded(keys);
            return target.exec();
          };
        }
        const fn = (target as unknown as Record<string, (...a: unknown[]) => KvPipeline>)[prop];
        if (typeof fn !== "function") return fn;
        return (...args: unknown[]) => {
          if (typeof args[0] === "string") keys.push(args[0]);
          fn.apply(target, args);
          return wrap;
        };
      },
    });
    return wrap;
  }
}
