import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * 帳號資料的儲存層。正式環境＝Google 試算表（透過 gas/Code.gs），本機沒設定
 * AUTH_GAS_URL 時改用 .cache/auth-dev-store.json 模擬同一組操作——兩者只做
 * 「通用表格讀寫」，帳號規則全部在 accounts.ts，所以本機測到的行為就是正式行為。
 */

export type TableName = "Users" | "Sessions" | "LoginLog";
export type Row = Record<string, string>;

export const TABLE_KEYS: Record<TableName, string> = {
  Users: "UserId",
  Sessions: "SessionId",
  LoginLog: "ID",
};

export type StoreOp =
  | { op: "read"; table: TableName }
  | { op: "append"; table: TableName; row: Row }
  | { op: "update"; table: TableName; key: string; patch: Row }
  | { op: "delete"; table: TableName; key: string }
  | { op: "trim"; table: TableName; keep: number };

export interface TableStore {
  readonly kind: "gas" | "file" | "memory";
  batch(ops: StoreOp[]): Promise<unknown[]>;
}

export class StoreUnavailableError extends Error {}

const GAS_TIMEOUT_MS = 20_000;

class GasStore implements TableStore {
  readonly kind = "gas" as const;
  constructor(private url: string, private secret: string) {}

  async batch(ops: StoreOp[]): Promise<unknown[]> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        // text/plain：Apps Script 網頁應用程式收 JSON 字串最穩定的方式
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ secret: this.secret, ops }),
        redirect: "follow",
        cache: "no-store",
        signal: AbortSignal.timeout(GAS_TIMEOUT_MS),
      });
    } catch (err) {
      throw new StoreUnavailableError(`帳號資料庫連線失敗：${(err as Error).message}`);
    }
    if (!res.ok) throw new StoreUnavailableError(`帳號資料庫回應 ${res.status}`);
    const data = (await res.json().catch(() => null)) as { success?: boolean; data?: unknown[]; message?: string } | null;
    if (!data?.success || !Array.isArray(data.data)) {
      throw new StoreUnavailableError(`帳號資料庫錯誤：${data?.message ?? "格式不正確"}`);
    }
    return data.data;
  }
}

/** 本機開發／測試用：所有資料在一個物件裡，可選擇是否寫回檔案。 */
export class MemoryStore implements TableStore {
  readonly kind: "file" | "memory";
  private data: Record<TableName, Row[]> | null = null;

  constructor(private file?: string) {
    this.kind = file ? "file" : "memory";
  }

  private async load(): Promise<Record<TableName, Row[]>> {
    const empty = { Users: [], Sessions: [], LoginLog: [] };
    // 檔案模式每次都重讀：proxy 與 API 在 next dev 裡是不同的模組實例，不能各自快取
    if (!this.file) return (this.data ??= empty);
    try {
      this.data = { ...empty, ...JSON.parse(await fs.readFile(this.file, "utf8")) };
    } catch {
      this.data = empty;
    }
    return this.data!;
  }

  async batch(ops: StoreOp[]): Promise<unknown[]> {
    const db = await this.load();
    const results = ops.map((op) => {
      const rows = db[op.table];
      const key = TABLE_KEYS[op.table];
      switch (op.op) {
        case "read":
          return rows.map((r) => ({ ...r }));
        case "append":
          rows.push(Object.fromEntries(Object.entries(op.row).map(([k, v]) => [k, String(v ?? "")])));
          return true;
        case "update": {
          const r = rows.find((x) => x[key] === op.key);
          if (!r) return false;
          for (const [k, v] of Object.entries(op.patch)) r[k] = String(v ?? "");
          return true;
        }
        case "delete": {
          const i = rows.findIndex((x) => x[key] === op.key);
          if (i < 0) return false;
          rows.splice(i, 1);
          return true;
        }
        case "trim": {
          const keep = Math.max(50, op.keep);
          if (rows.length > keep) rows.splice(0, rows.length - keep);
          return true;
        }
      }
    });
    if (this.file) {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(db, null, 2), "utf8");
    }
    return results;
  }
}

let cached: TableStore | null = null;

/** 依環境變數決定用哪一種儲存；正式環境沒設定試算表就丟錯（不會默默改用本機檔案）。 */
export function getStore(): TableStore {
  if (cached) return cached;
  const url = process.env.AUTH_GAS_URL;
  const secret = process.env.AUTH_GAS_SECRET;
  if (url && secret) return (cached = new GasStore(url, secret));
  if (process.env.NODE_ENV === "production") {
    throw new StoreUnavailableError("帳號資料庫尚未設定（AUTH_GAS_URL / AUTH_GAS_SECRET）");
  }
  return (cached = new MemoryStore(path.join(process.cwd(), ".cache", "auth-dev-store.json")));
}

/** 測試用：換成指定的儲存。 */
export function setStoreForTests(store: TableStore | null): void {
  cached = store;
}
