import { promises as fs } from "node:fs";
import { redis } from "@/lib/data/kv";
import path from "node:path";

/**
 * 帳號資料（以及使用者回饋）的儲存層。正式環境＝Google 試算表（透過 gas/Code.gs），本機沒設定
 * AUTH_GAS_URL 時改用 .cache/auth-dev-store.json 模擬同一組操作——兩者只做
 * 「通用表格讀寫」，帳號規則全部在 accounts.ts，所以本機測到的行為就是正式行為。
 */

export type TableName =
  | "Users"
  | "Sessions"
  | "LoginLog"
  | "Feedback"
  | "Holdings"
  | "Indicators"
  | "Strategies"
  | "Sims"
  | "SimTrades"
  | "SimNav"
  // 永久紀錄（durableKv.ts：原本存 Redis 的資料，一個欄位一列）
  | "RatingLog"
  | "RatingConfirm"
  | "Learning"
  | "SimPortfolio"
  | "BriefArchive"
  | "ModelStats"
  // 即時提醒設定（每個帳號一列）
  | "Alerts"
  | "VolumeHistory";
export type Row = Record<string, string>;

export const TABLE_KEYS: Record<TableName, string> = {
  Users: "UserId",
  Sessions: "SessionId",
  LoginLog: "ID",
  Feedback: "ID",
  Holdings: "ID",
  Indicators: "ID",
  Strategies: "ID",
  Sims: "ID",
  SimTrades: "ID",
  SimNav: "ID",
  RatingLog: "ID",
  RatingConfirm: "ID",
  Learning: "ID",
  SimPortfolio: "ID",
  BriefArchive: "ID",
  ModelStats: "ID",
  Alerts: "ID",
  VolumeHistory: "ID",
};

export type StoreOp =
  | { op: "read"; table: TableName }
  | { op: "append"; table: TableName; row: Row }
  | { op: "update"; table: TableName; key: string; patch: Row }
  | { op: "delete"; table: TableName; key: string }
  | { op: "trim"; table: TableName; keep: number }
  /** 把「col＝value」的所有列換成 rows（例如整份關注清單換新），一次完成 */
  | { op: "replaceWhere"; table: TableName; col: string; value: string; rows: Row[] }
  /** 只讀 col 欄位值在 values 裡的列（在 Google 端篩選） */
  | { op: "readKeys"; table: TableName; col: string; values: string[] }
  /** 依主鍵批次新增或更新 */
  | { op: "upsert"; table: TableName; rows: Row[] }
  /** 刪除 col 欄位值在 values 裡的所有列 */
  | { op: "deleteWhere"; table: TableName; col: string; values: string[] };

/** 不會改資料的操作（可以重送、不用排隊） */
export const isReadOp = (o: StoreOp) => o.op === "read" || o.op === "readKeys";

export interface TableStore {
  readonly kind: "gas" | "file" | "memory";
  batch(ops: StoreOp[]): Promise<unknown[]>;
}

export class StoreUnavailableError extends Error {
  constructor(message: string, readonly retryable = false, readonly lockTimeout = false) {
    super(message);
  }
}

/** Apps Script 回的技術訊息 → 使用者看得懂的說明（原始訊息只留在伺服器紀錄） */
const BUSY_HINT = "試算表資料庫目前比較忙，請等幾秒再按一次（資料沒有遺失）";
function friendlyStoreMessage(raw: string): string {
  if (/Lock timeout|另一個|holding the lock/i.test(raw)) return `${BUSY_HINT}。`;
  return `帳號資料庫錯誤：${raw}`;
}

// Apps Script 平常 2～5 秒，偶爾（例如剛建好的試算表第一次寫入）超過 20 秒，2026-10-07 實測；放寬到 45 秒
const GAS_TIMEOUT_MS = 45_000;

/** 讀過的資料表在同一個伺服器實例暫存多久（有寫入會立即作廢；跨實例最多晚這麼久看到別人的修改） */
const READ_CACHE_MS = 60_000;
/** 試算表讀取失敗時，最多容許拿多舊的暫存資料先頂著 */
const STALE_OK_MS = 10 * 60_000;
/**
 * 有 Redis 時，小表的讀取暫存也放進 Redis，所有伺服器實例共用（Vercel 每個請求常落在不同實例，
 * 只靠記憶體幾乎命中不了）。大表（登入紀錄、交易紀錄、回饋、每日淨值）不放，避免超過單筆大小上限。
 */
const SHARED_CACHE_TABLES = new Set<TableName>(["Users", "Sessions", "Holdings", "Indicators", "Strategies", "Sims", "Alerts"]);
const sharedKey = (t: TableName) => `gas-table:v1:${t}`;

/** 取結果（Google 轉址後的網址）失敗時重試幾次 */
const FETCH_RESULT_ATTEMPTS = 4;
/** 排不到鎖時重送一次：第一次失敗得在這段時間內發生（Apps Script 等鎖最久 20 秒）才重送，避免整體拖太久 */
const LOCK_RETRY_WITHIN_MS = 28_000;
const LOCK_RETRY_GAP_MS = 1_500;

/**
 * Google Apps Script 的回應流程：POST 執行程式 → 302 轉址到 script.googleusercontent.com 取結果。
 * 偶爾「取結果」那一步回 404（程式已經執行過了；FonegleWeb 也遇過，2026-10-08 使用者儲存策略時
 * 看到「帳號資料庫回應 404」）。所以這裡自己處理轉址：取結果失敗只重取結果、不重新 POST，
 * 寫入也能安全重試，不會重複寫入。
 *
 * 另外每次呼叫 2～5 秒，同一個操作常要讀好幾張表：讀過的表在記憶體暫存 READ_CACHE_MS，
 * 純讀取只送還沒暫存的表，寫入後把寫過的表作廢。
 */
class GasStore implements TableStore {
  readonly kind = "gas" as const;
  private cache = new Map<TableName, { rows: Row[]; at: number }>();
  constructor(private url: string, private secret: string) {}

  async batch(ops: StoreOp[]): Promise<unknown[]> {
    const now = Date.now();
    const fresh = (t: TableName) => {
      const c = this.cache.get(t);
      return c && now - c.at < READ_CACHE_MS ? c : null;
    };
    if (ops.every((o) => o.op === "readKeys")) return this.sendWithRetry(ops, true);
    if (ops.every(isReadOp) && ops.some((o) => o.op === "readKeys")) {
      // 一般讀取＋篩選讀取混在同一批（例如登入）：一次送出，可重試；一般讀取的結果順便暫存
      const results = await this.sendWithRetry(ops, true);
      ops.forEach((o, i) => {
        if (o.op === "read") this.cache.set(o.table, { rows: results[i] as Row[], at: Date.now() });
      });
      return results;
    }
    if (ops.every((o) => o.op === "read")) {
      let missing = [...new Set(ops.filter((o) => !fresh(o.table)).map((o) => o.table))];
      if (missing.length) await this.fillFromShared(missing);
      missing = missing.filter((t) => !fresh(t));
      if (missing.length) {
        try {
          const results = await this.sendWithRetry(missing.map((table) => ({ op: "read" as const, table })), true);
          missing.forEach((t, i) => this.cache.set(t, { rows: results[i] as Row[], at: Date.now() }));
          await this.saveShared(missing, results as Row[][]);
        } catch (err) {
          // 試算表暫時讀不到（逾時、Google 偶發錯誤）：這台伺服器 10 分鐘內讀過就先用舊資料，
          // 畫面照常顯示；沒有舊資料才報錯。寫入的表在寫入時已作廢，不會拿到自己剛改之前的舊資料。
          const usable = missing.every((t) => {
            const c = this.cache.get(t);
            return c && Date.now() - c.at < STALE_OK_MS;
          });
          if (!usable) throw err;
          console.error("[gas] 讀取失敗，暫用舊資料：", (err as Error).message);
        }
      }
      return ops.map((o) => this.cache.get(o.table)!.rows.map((r) => ({ ...r })));
    }
    // 有寫入：先作廢（就算失敗，之後也重讀最新的），成功後再作廢一次（避免途中被別的請求填回舊資料）
    const written = new Set(ops.filter((o) => !isReadOp(o)).map((o) => o.table));
    await this.invalidate(written);
    const results = await this.sendWithRetry(ops, false);
    await this.invalidate(written);
    ops.forEach((o, i) => {
      if (o.op === "read" && !written.has(o.table)) this.cache.set(o.table, { rows: results[i] as Row[], at: Date.now() });
    });
    return results;
  }

  private async fillFromShared(tables: TableName[]): Promise<void> {
    const shared = tables.filter((t) => SHARED_CACHE_TABLES.has(t));
    if (!redis || shared.length === 0) return;
    try {
      const hits = await redis.mget<Array<{ rows: Row[]; at: number } | null>>(...shared.map(sharedKey));
      shared.forEach((t, i) => {
        const h = hits[i];
        if (h && Array.isArray(h.rows) && Date.now() - h.at < READ_CACHE_MS) this.cache.set(t, h);
      });
    } catch {
      // Redis 暫時不通就直接讀試算表
    }
  }

  private async saveShared(tables: TableName[], results: Row[][]): Promise<void> {
    if (!redis) return;
    const p = redis.pipeline();
    let n = 0;
    tables.forEach((t, i) => {
      if (!SHARED_CACHE_TABLES.has(t)) return;
      p.set(sharedKey(t), { rows: results[i], at: Date.now() }, { px: READ_CACHE_MS });
      n++;
    });
    if (n) await p.exec().catch(() => {});
  }

  private async invalidate(tables: Set<TableName>): Promise<void> {
    tables.forEach((t) => this.cache.delete(t));
    const shared = [...tables].filter((t) => SHARED_CACHE_TABLES.has(t));
    if (redis && shared.length) await redis.del(...shared.map(sharedKey)).catch(() => {});
  }

  private async sendWithRetry(ops: StoreOp[], readOnly: boolean): Promise<unknown[]> {
    const startedAt = Date.now();
    try {
      return await this.send(ops);
    } catch (err) {
      if (err instanceof StoreUnavailableError) {
        // 純讀取在 POST 這一步就失敗（網路錯誤）可以整個重送；寫入不重送，避免重複寫入
        if (readOnly && err.retryable) return this.send(ops);
        // 「排不到鎖」＝這批寫入完全沒有執行，重送不會重複寫入；等一下別人寫完就排得到了
        // （2026-10-08 使用者看到 Lock timeout：Apps Script 寫入實際上一筆接一筆處理，短時間湧入就會排隊超過 20 秒）
        if (err.lockTimeout && Date.now() - startedAt < LOCK_RETRY_WITHIN_MS) {
          await new Promise((r) => setTimeout(r, LOCK_RETRY_GAP_MS));
          return this.send(ops);
        }
      }
      throw err;
    }
  }

  private async send(ops: StoreOp[]): Promise<unknown[]> {
    const signal = AbortSignal.timeout(GAS_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        // text/plain：Apps Script 網頁應用程式收 JSON 字串最穩定的方式
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ secret: this.secret, ops }),
        redirect: "manual",
        cache: "no-store",
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw new StoreUnavailableError(`${BUSY_HINT}（連線逾時）。`);
      console.error("[gas]", (err as Error).message);
      throw new StoreUnavailableError("連不上帳號資料庫（網路暫時有問題），請稍後再試一次。", true);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      // 程式已經執行完，結果放在轉址後的網址：只重取這個網址
      res = await this.fetchResult(location, signal);
    }
    if (!res.ok) throw new StoreUnavailableError(`帳號資料庫回應 ${res.status}`, res.status === 404 || res.status >= 500);
    const bodyText = await res.text().catch(() => "");
    let data: { success?: boolean; data?: unknown[]; message?: string } | null = null;
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = null;
    }
    if (!data?.success || !Array.isArray(data.data)) {
      // 回的不是 JSON（例如 Google 的錯誤網頁：同時執行太多、配額用完）：把開頭記下來才查得到原因
      const snippet = bodyText.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
      const msg = data?.message ?? `格式不正確${snippet ? `（回應開頭：${snippet}）` : "（空回應）"}`;
      // 新功能用到新資料表，但試算表那邊的 Apps Script 還是舊版
      if (msg.includes("未知的資料表") || msg.includes("未知的操作")) {
        throw new StoreUnavailableError(`試算表的 Apps Script 不是最新版（${msg}）：請把 gas/Code.gs 整份貼上，並「部署 → 管理部署作業 → 編輯 → 新版本」`);
      }
      console.error("[gas]", msg);
      throw new StoreUnavailableError(friendlyStoreMessage(msg), false, /Lock timeout|holding the lock/i.test(msg));
    }
    return data.data;
  }

  private async fetchResult(url: string, signal: AbortSignal): Promise<Response> {
    let last: Response | null = null;
    for (let attempt = 0; attempt < FETCH_RESULT_ATTEMPTS; attempt++) {
      try {
        last = await fetch(url, { cache: "no-store", redirect: "follow", signal });
        if (last.ok || (last.status !== 404 && last.status < 500)) return last;
      } catch (err) {
        if (signal.aborted) throw new StoreUnavailableError(`${BUSY_HINT}（連線逾時）。`);
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    if (last) return last;
    throw new StoreUnavailableError("連不上帳號資料庫（網路暫時有問題），請稍後再試一次。", true);
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
    const empty: Record<TableName, Row[]> = {
      Users: [], Sessions: [], LoginLog: [], Feedback: [], Holdings: [], Indicators: [], Strategies: [], Sims: [], SimTrades: [], SimNav: [],
      RatingLog: [], RatingConfirm: [], Learning: [], SimPortfolio: [], BriefArchive: [], ModelStats: [], Alerts: [], VolumeHistory: [],
    };
    // 檔案模式每次都重讀：proxy 與 API 在 next dev 裡是不同的模組實例，不能各自快取
    if (!this.file) return (this.data ??= empty);
    try {
      this.data = { ...empty, ...JSON.parse(await fs.readFile(this.file, "utf8")) };
    } catch {
      this.data = empty;
    }
    return this.data!;
  }

  /**
   * 檔案模式要排隊：同一個 next dev 程序裡 proxy 與各 API 是不同的模組實例，若兩個請求同時
   * 「讀檔→改→寫檔」，後寫的會用舊資料蓋掉前一個的變更（2026-10-08 實際發生：模擬倉剛建立
   * 就被同時進行的關注清單同步蓋掉）。鎖放在 globalThis，所有實例共用。正式環境的試算表
   * 由 Apps Script 的 LockService 排隊，不受影響。
   */
  batch(ops: StoreOp[]): Promise<unknown[]> {
    if (!this.file) return this.run(ops);
    const g = globalThis as { __swStoreQueue?: Promise<unknown> };
    const next = (g.__swStoreQueue ?? Promise.resolve()).catch(() => {}).then(() => this.run(ops));
    g.__swStoreQueue = next;
    return next;
  }

  private async run(ops: StoreOp[]): Promise<unknown[]> {
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
        case "readKeys": {
          const want = new Set(op.values);
          return rows.filter((x) => want.has(x[op.col])).map((x) => ({ ...x }));
        }
        case "upsert": {
          for (const r of op.rows) {
            const clean = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v ?? "")]));
            const hit = rows.find((x) => x[key] === clean[key]);
            if (hit) Object.assign(hit, clean);
            else rows.push(clean);
          }
          return op.rows.length;
        }
        case "deleteWhere": {
          const want = new Set(op.values);
          const before = rows.length;
          const kept = rows.filter((x) => !want.has(x[op.col]));
          rows.length = 0;
          rows.push(...kept);
          return before - kept.length;
        }
        case "replaceWhere": {
          const kept = rows.filter((x) => x[op.col] !== op.value);
          rows.length = 0;
          rows.push(...kept, ...op.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v ?? "")]))));
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
