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
  constructor(message: string, readonly retryable = false, readonly lockTimeout = false, readonly uncertain = false) {
    super(message);
  }
}

/** Apps Script 回的技術訊息 → 使用者看得懂的說明（原始訊息只留在伺服器紀錄） */
const WRITE_UNCERTAIN_HINT = "試算表資料庫回應太慢，這個動作可能已經完成了——請先重新整理頁面確認；真的沒有成功再按一次（直接重按可能會重複新增）。";
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
/** 有共用暫存的表，各台伺服器自己的記憶體暫存最多留多久 */
const LOCAL_SHARED_TTL_MS = 3_000;
const sharedKey = (t: TableName) => `gas-table:v1:${t}`;

/** 結果這麼久還沒回來就對沖（再送一次同 reqId 的請求）；正常時結果 0.1～0.2 秒就回來，POST 約 1.2 秒 */
const HEDGE_MS = 3_000;
/** 排不到鎖時重送一次：第一次失敗得在這段時間內發生（Apps Script 等鎖最久 20 秒）才重送，避免整體拖太久 */
const LOCK_RETRY_WITHIN_MS = 25_000;
const LOCK_RETRY_GAP_MS = 1_500;
/** 最多重送幾次、每次重送最多等多久、整體重送預算（第一次送出不算） */
const MAX_RETRIES = 2;
const RETRY_TIMEOUT_MS = 25_000;
const RETRY_BUDGET_MS = 70_000;
/** doGet 的健康檢查文字（Apps Script 的 doGet 回應；結果網址被讀第二次時就會拿到它） */
const GAS_BANNER = "StockRadar 帳號資料庫運作中";
const newReqId = () => crypto.randomUUID().replace(/-/g, "");

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
  /** 從 Apps Script 回應學到的協定版本（0＝還不知道／舊版） */
  private protocol = 0;
  constructor(private url: string, private secret: string) {}

  async batch(ops: StoreOp[]): Promise<unknown[]> {
    const now = Date.now();
    const fresh = (t: TableName) => {
      const c = this.cache.get(t);
      // 共用暫存的表：寫入只能作廢「這台」的記憶體暫存與共用暫存，別台伺服器的記憶體暫存沒辦法通知，
      // 所以那些表的記憶體暫存只留幾秒、之後走共用暫存（寫入時已作廢）——否則新增完馬上重讀，
      // 可能落在另一台拿到最多 60 秒前的舊列表（2026-10-08 驗證：新增策略後列表沒出現、要重整）。
      const ttl = redis && SHARED_CACHE_TABLES.has(t) ? LOCAL_SHARED_TTL_MS : READ_CACHE_MS;
      return c && now - c.at < ttl ? c : null;
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

  /**
   * 送出並在「安全的情況」下重送：
   * - 排不到鎖（Lock timeout）：這批完全沒執行，直接重送。
   * - 結果遺失（網路錯誤、取結果 404／5xx、取到 doGet 健康檢查文字）：Google 回結果的網址只能讀一次，
   *   寫入其實可能已經執行。純讀取、或內容都是重複執行也沒差的寫入（沒有 append）、或 Apps Script 是 v2
   *   （依 reqId 暫存結果，重送只會拿到上次結果、不會重複執行）才重送；否則回報錯誤，不冒重複新增的險。
   */
  private async sendWithRetry(ops: StoreOp[], readOnly: boolean): Promise<unknown[]> {
    const reqId = newReqId();
    const startedAt = Date.now();
    for (let attempt = 0; ; attempt++) {
      const elapsed = Date.now() - startedAt;
      try {
        const timeout = attempt === 0 ? GAS_TIMEOUT_MS : Math.min(RETRY_TIMEOUT_MS, Math.max(8_000, RETRY_BUDGET_MS - elapsed));
        return await this.send(ops, timeout, reqId, readOnly || this.replaySafe(ops));
      } catch (err) {
        if (!(err instanceof StoreUnavailableError) || attempt >= MAX_RETRIES) throw err;
        const lockRetry = err.lockTimeout && elapsed < LOCK_RETRY_WITHIN_MS;
        const lostRetry = err.retryable && (readOnly || this.replaySafe(ops)) && elapsed < RETRY_BUDGET_MS - 8_000;
        if (!lockRetry && !lostRetry) {
          // 寫入「可能已經完成但沒收到確認」：請使用者先重新整理確認，不要直接再按（會重複新增）
          if (!readOnly && (err.uncertain || err.retryable)) throw new StoreUnavailableError(WRITE_UNCERTAIN_HINT);
          throw err;
        }
        await new Promise((r) => setTimeout(r, LOCK_RETRY_GAP_MS));
      }
    }
  }

  /** 結果遺失時重送這批寫入會不會造成重複：Apps Script v2 有結果暫存；舊版只有沒有 append 才安全 */
  private replaySafe(ops: StoreOp[]): boolean {
    return this.protocol >= 2 || ops.every((o) => o.op !== "append");
  }

  /**
   * 送出一次。hedge＝對沖：Google 回結果的轉址服務有時 7～15 秒才回（甚至 404），而 POST 本身只要約 1.2 秒
   * （2026-10-08 在 Vercel 端實測，見 /api/cron/gas-ping）；超過 HEDGE_MS 還沒收到結果，就用同一個 reqId 再送一次，
   * 誰先拿到結果用誰。只在重複執行安全時才對沖（純讀取、無 append 的寫入、或 Apps Script v2 有結果暫存）。
   */
  private send(ops: StoreOp[], timeoutMs = GAS_TIMEOUT_MS, reqId = newReqId(), hedge = false): Promise<unknown[]> {
    const signal = AbortSignal.timeout(timeoutMs);
    const first = this.sendOnce(ops, reqId, signal);
    if (!hedge) return first;
    return new Promise<unknown[]>((resolve, reject) => {
      let settled = false;
      let pending = 1;
      let hedged = false;
      const errors: unknown[] = [];
      const attach = (p: Promise<unknown[]>) =>
        p.then(
          (v) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(v);
          },
          (err) => {
            errors.push(err);
            pending--;
            // 還沒對沖就失敗：直接丟出去，交給外層重送；對沖後要兩邊都失敗才算失敗
            if (!settled && (pending === 0 || !hedged)) {
              settled = true;
              clearTimeout(timer);
              reject(errors.find((e) => e instanceof StoreUnavailableError && !e.retryable) ?? errors[0]);
            }
          },
        );
      const timer = setTimeout(() => {
        if (settled) return;
        hedged = true;
        pending++;
        console.warn("[gas] 結果超過 %d 毫秒還沒回來，用同一個 reqId 再送一次", HEDGE_MS);
        attach(this.sendOnce(ops, reqId, signal));
      }, HEDGE_MS);
      attach(first);
    });
  }

  private async sendOnce(ops: StoreOp[], reqId: string, signal: AbortSignal): Promise<unknown[]> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        // text/plain：Apps Script 網頁應用程式收 JSON 字串最穩定的方式
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ secret: this.secret, ops, reqId }),
        redirect: "manual",
        cache: "no-store",
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw new StoreUnavailableError(`${BUSY_HINT}（連線逾時）。`, false, false, true);
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
    let data: { success?: boolean; data?: unknown; message?: string; v?: number } | null = null;
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = null;
    }
    if (typeof data?.v === "number") this.protocol = Math.max(this.protocol, data.v);
    // 讀到的是 doGet 的健康檢查文字：真正的結果網址已經被讀過（只能讀一次），這次的結果遺失了
    if (data?.success && data.data === GAS_BANNER) {
      console.error("[gas] 結果網址已被讀過，取到健康檢查回應，結果遺失");
      throw new StoreUnavailableError(`${BUSY_HINT}（沒收到確認）。`, true, false, true);
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
    return data.data as unknown[];
  }

  /**
   * 取結果：只讀一次。Google 的結果網址只能讀一次（再讀只會拿到 doGet 的健康檢查文字），
   * 所以失敗不在這裡重取，交給上層用同一個 reqId 重送 POST。
   */
  private async fetchResult(url: string, signal: AbortSignal): Promise<Response> {
    try {
      return await fetch(url, { cache: "no-store", redirect: "follow", signal });
    } catch (err) {
      if (signal.aborted) throw new StoreUnavailableError(`${BUSY_HINT}（連線逾時）。`, false, false, true);
      console.error("[gas]", (err as Error).message);
      throw new StoreUnavailableError("連不上帳號資料庫（網路暫時有問題），請稍後再試一次。", true);
    }
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
