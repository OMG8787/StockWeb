import type { Row, StoreOp, TableName, TableStore } from "./store";

/**
 * 用 Upstash Redis 當帳號與資料表的儲存（2026-10-08 使用者要求「資料庫改回之前的線上」：
 * Google 試算表／Apps Script 偶爾一個操作要 10～50 秒，Redis 每個指令約 10～30 毫秒）。
 * 跟 GasStore、MemoryStore 同一個介面（TableStore），所有上層程式不用改。
 *
 * 儲存方式：每張表一個 hash，欄位＝主鍵值、值＝整列（JSON）；整列裡多一個 `__n`（寫入順序），
 * 讀取時依 `__n` 排序後拿掉——跟試算表「新增的列在最下面」的順序行為一樣。
 * 主鍵重複時以後寫的為準（試算表版會產生兩列，沒有任何程式依賴那種行為）。
 *
 * 指令數（Upstash 免費額度有每月上限）：read＝1、readKeys＝1、append／upsert＝1～2、update＝2、delete＝1；
 * 同一個實例短時間內重複讀同一張表走記憶體暫存（READ_CACHE_MS），該表有寫入就立即作廢。
 */

/** 本站用到的 Upstash Redis 指令子集（方便測試時換成假的） */
export interface HashClient {
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  hget(key: string, field: string): Promise<unknown>;
  hmget(key: string, ...fields: string[]): Promise<Record<string, unknown> | null>;
  hset(key: string, values: Record<string, unknown>): Promise<unknown>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
}

const READ_CACHE_MS = 2_000;
const tableKey = (t: TableName) => `tbl:v1:${t}`;

let seq = 0;
/** 寫入順序：時間（毫秒）× 1000 ＋ 同一毫秒內的序號；不同實例之間以時間為準 */
const nextOrder = () => Date.now() * 1000 + (seq++ % 1000);

const clean = (r: Row): Row => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v ?? "")]));

type Stored = Row & { __n?: string };

/** 從 Redis 取回的值（Upstash 會自動把 JSON 還原成物件；保險起見字串也解析一次） */
function parse(v: unknown): Stored | null {
  if (v == null) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as Stored;
    } catch {
      return null;
    }
  }
  return v as Stored;
}

function strip(r: Stored): Row {
  const { __n: _n, ...rest } = r;
  void _n;
  return rest;
}

export class RedisTableStore implements TableStore {
  readonly kind = "redis" as const;
  private cache = new Map<TableName, { rows: Stored[]; at: number }>();

  constructor(
    private client: HashClient,
    private keys: Record<TableName, string>,
    private fail: (message: string) => Error,
  ) {}

  async batch(ops: StoreOp[]): Promise<unknown[]> {
    try {
      const out: unknown[] = [];
      // 照順序一個一個做：同一批裡後面的操作要看得到前面的結果（跟試算表版一樣）
      for (const op of ops) out.push(await this.run(op));
      return out;
    } catch (err) {
      console.error("[redis-store]", (err as Error).message);
      throw this.fail("資料庫（Redis）暫時連不上，請稍後再試一次。");
    }
  }

  /** 整張表（依寫入順序） */
  private async loadAll(table: TableName): Promise<Stored[]> {
    const c = this.cache.get(table);
    if (c && Date.now() - c.at < READ_CACHE_MS) return c.rows;
    const all = (await this.client.hgetall(tableKey(table))) ?? {};
    const rows = Object.values(all)
      .map(parse)
      .filter((r): r is Stored => !!r)
      .sort((a, b) => Number(a.__n ?? 0) - Number(b.__n ?? 0));
    this.cache.set(table, { rows, at: Date.now() });
    return rows;
  }

  private async run(op: StoreOp): Promise<unknown> {
    const table = op.table;
    const key = this.keys[table];
    const hash = tableKey(table);
    const touch = () => this.cache.delete(table);
    switch (op.op) {
      case "read":
        return (await this.loadAll(table)).map((r) => strip(r));
      case "readKeys": {
        const want = new Set(op.values);
        return (await this.loadAll(table)).filter((r) => want.has(r[op.col])).map((r) => strip(r));
      }
      case "append": {
        const row = clean(op.row);
        touch();
        await this.client.hset(hash, { [row[key] ?? ""]: { ...row, __n: String(nextOrder()) } });
        return true;
      }
      case "update": {
        const cur = parse(await this.client.hget(hash, op.key));
        if (!cur) return false;
        touch();
        await this.client.hset(hash, { [op.key]: { ...cur, ...clean(op.patch) } });
        return true;
      }
      case "delete": {
        touch();
        return Number(await this.client.hdel(hash, op.key)) > 0;
      }
      case "trim": {
        const keep = Math.max(50, op.keep);
        const rows = await this.loadAll(table);
        if (rows.length <= keep) return true;
        touch();
        const drop = rows.slice(0, rows.length - keep).map((r) => r[key]);
        await this.client.hdel(hash, ...drop);
        return true;
      }
      case "upsert": {
        if (op.rows.length === 0) return 0;
        const rows = op.rows.map(clean);
        const existing = (await this.client.hmget(hash, ...rows.map((r) => r[key]))) ?? {};
        const values: Record<string, Stored> = {};
        for (const r of rows) {
          const hit = parse(existing[r[key]]);
          values[r[key]] = hit ? { ...hit, ...r } : { ...r, __n: String(nextOrder()) };
        }
        touch();
        await this.client.hset(hash, values);
        return rows.length;
      }
      case "deleteWhere": {
        const want = new Set(op.values);
        const drop = (await this.loadAll(table)).filter((r) => want.has(r[op.col])).map((r) => r[key]);
        if (drop.length === 0) return 0;
        touch();
        await this.client.hdel(hash, ...drop);
        return drop.length;
      }
      case "replaceWhere": {
        const drop = (await this.loadAll(table)).filter((r) => r[op.col] === op.value).map((r) => r[key]);
        touch();
        if (drop.length) await this.client.hdel(hash, ...drop);
        if (op.rows.length) {
          const values: Record<string, Stored> = {};
          for (const r of op.rows.map(clean)) values[r[key]] = { ...r, __n: String(nextOrder()) };
          await this.client.hset(hash, values);
        }
        return true;
      }
    }
  }
}
