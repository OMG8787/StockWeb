import { cached, mapWithConcurrency, peekCached, writeCached } from "./cache";
import { datedSnapshot, getForeignHoldingsBatch } from "./foreignHoldings";
import { fetchTpexJson } from "./tpex";
import { fetchTwseInstitutionalTradingAll, fetchTwseMarginTradingAll } from "./twse";

/**
 * 台股個股「過去 N 個交易日」的籌碼逐日資料（AI 問答【歷史脈絡】用，見
 * ai/grounding/history.ts）：三大法人買賣超、融資餘額／限額、外資持股比例。
 *
 * 三份都是官方「全市場整包、可帶日期查」的報表（TWSE：T86／MI_MARGN／MI_QFIIS；
 * TPEx：官網 insti/dailyTrade／margin/balance／insti/qfii）。做法：
 * - 依「交易所＋日期」整包快取，所有股票共用；已公布的交易日資料不會再變 → 7 天 TTL。
 *   每檔只存需要的幾個數字，避免 Redis payload 過大。
 * - 交易日清單由呼叫端從日K線取（真的有開盤的日子），不自己猜週末/連假。
 * - 一次最多回補 MAX_HISTORY_DAYS 天、併發 HISTORY_FETCH_CONCURRENCY、單日失敗重試
 *   帶退避（TWSE 對 Vercel 出口 IP 連續請求會回 428/503，同 twse.ts fetchMonthResilient
 *   的思路）。單一天最後仍失敗就 fail open：那天標為缺，不拖垮其他天。
 * - 「當天還沒公布」（盤中、或收盤後官方還沒出報表）不是錯誤，也不能長效快取成空的：
 *   不重試，只在實例記憶體裡記 NOT_PUBLISHED_RETRY_MS，之後再試。
 * - 外資持股比例：過去日期直接共用 foreignHoldings.ts 的依日期快取；「今天」改讀它的
 *   最新一天（避免把「今天還沒公布」的空報表用日期 key 長效快取下來）。
 */

export type TwHistoryExchange = "TWSE" | "TPEX";

/** 一次最多回補幾個交易日（三大法人用滿；融資／外資持股只取最近 RATIO_DAYS 天） */
export const MAX_HISTORY_DAYS = 20;
export const RATIO_DAYS = 6;
const HISTORY_FETCH_CONCURRENCY = 3;
const HISTORY_RETRY_ATTEMPTS = 3;
const DATED_TABLE_TTL_MS = 7 * 24 * 60 * 60_000;
/** 每檔彙整結果（全部天數都齊才寫）：key 含最後一個交易日，跨日自然換 key */
const SYMBOL_SUMMARY_TTL_MS = 12 * 60 * 60_000;
const NOT_PUBLISHED_RETRY_MS = 10 * 60_000;

/** [外資(含外資自營商), 投信, 自營商] 買賣超股數 */
type InstiRow = [number, number, number];
/** [融資餘額(張), 融資限額(張)] */
type MarginRow = [number, number];

class NotPublishedError extends Error {}

const notPublishedUntil = new Map<string, number>();

function taipeiTodayCompact(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date()).replace(/-/g, "");
}

function parseNum(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = parseFloat(raw.replace(/[,\s%]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function tpexDateParam(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}%2F${yyyymmdd.slice(4, 6)}%2F${yyyymmdd.slice(6, 8)}`;
}

/** 單日報表：429/428/503/逾時等暫時性錯誤重試帶退避；「沒資料」不重試。 */
async function withRetry<T>(key: string, load: () => Promise<T>): Promise<T> {
  const blockedUntil = notPublishedUntil.get(key);
  if (blockedUntil && blockedUntil > Date.now()) throw new NotPublishedError(key);
  let lastErr: unknown;
  for (let attempt = 0; attempt < HISTORY_RETRY_ATTEMPTS; attempt++) {
    try {
      return await load();
    } catch (err) {
      if (err instanceof NotPublishedError) {
        if (notPublishedUntil.size > 200) notPublishedUntil.clear();
        notPublishedUntil.set(key, Date.now() + NOT_PUBLISHED_RETRY_MS);
        throw err;
      }
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1) + Math.random() * 400));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 三大法人
// ---------------------------------------------------------------------------

async function loadTwseInsti(yyyymmdd: string): Promise<Record<string, InstiRow>> {
  const map = await fetchTwseInstitutionalTradingAll(yyyymmdd);
  const iso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  if (map.size === 0) throw new NotPublishedError(`T86 ${yyyymmdd}`);
  const rows: Record<string, InstiRow> = {};
  for (const [code, c] of map) {
    // 回傳日期跟查詢日期不同（理論上不會發生）就當作沒有這天，避免錯日資料被長效快取。
    if (c.date && c.date !== iso) throw new NotPublishedError(`T86 date mismatch ${yyyymmdd}`);
    rows[code] = [c.foreignNetShares ?? 0, c.trustNetShares ?? 0, c.dealerNetShares ?? 0];
  }
  return rows;
}

interface TpexTableResponse {
  tables?: Array<{ date?: string; totalCount?: number; fields?: string[]; data?: string[][] }>;
}

/**
 * 櫃買官網「三大法人日交易資訊」（openapi 版只有最新一天，不能帶日期）。欄位名稱整排都是
 * 「買進股數／賣出股數／買賣超股數」重複，只能靠位置：[代號, 名稱, 外資不含自營(3欄),
 * 外資自營(3), 外資合計(3), 投信(3), 自營自行(3), 自營避險(3), 自營合計(3), 三大法人合計]。
 * 2026-10-04 實測 6488：3,775,551 + (-112,200) + 89,552 = 3,752,903 ＝ 合計。版面若改了，
 * 合計對不起來就整天丟錯（不快取），不會把錯位的數字當真。
 */
const TPEX_INSTI_COL = { foreign: 10, trust: 13, dealer: 22, total: 23 } as const;

async function loadTpexInsti(yyyymmdd: string): Promise<Record<string, InstiRow>> {
  const payload = await fetchTpexJson<TpexTableResponse>(
    `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${tpexDateParam(yyyymmdd)}&response=json`,
    10_000
  );
  const table = payload.tables?.[0];
  if (!table?.data || table.data.length === 0) throw new NotPublishedError(`TPEx insti ${yyyymmdd}`);
  const rows: Record<string, InstiRow> = {};
  let checked = 0;
  for (const row of table.data) {
    const code = row[0]?.trim();
    const f = parseNum(row[TPEX_INSTI_COL.foreign]);
    const t = parseNum(row[TPEX_INSTI_COL.trust]);
    const d = parseNum(row[TPEX_INSTI_COL.dealer]);
    if (!code || f == null || t == null || d == null) continue;
    const total = parseNum(row[TPEX_INSTI_COL.total]);
    if (total != null && checked < 20) {
      checked++;
      if (f + t + d !== total) throw new Error(`TPEx insti layout changed (${code})`);
    }
    rows[code] = [f, t, d];
  }
  return rows;
}

function instiTable(exchange: TwHistoryExchange, yyyymmdd: string): Promise<Record<string, InstiRow>> {
  const key = `chips-history:insti:${exchange}:${yyyymmdd}:v1`;
  return cached(key, DATED_TABLE_TTL_MS, () =>
    withRetry(key, () => (exchange === "TWSE" ? loadTwseInsti(yyyymmdd) : loadTpexInsti(yyyymmdd)))
  );
}

// ---------------------------------------------------------------------------
// 融資餘額／限額
// ---------------------------------------------------------------------------

async function loadTwseMargin(yyyymmdd: string): Promise<Record<string, MarginRow>> {
  const map = await fetchTwseMarginTradingAll(yyyymmdd);
  const iso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  const rows: Record<string, MarginRow> = {};
  for (const [code, c] of map) {
    if (c.marginDate && c.marginDate !== iso) throw new NotPublishedError(`MI_MARGN date mismatch ${yyyymmdd}`);
    if (c.marginBalance != null && c.marginQuota != null) rows[code] = [c.marginBalance, c.marginQuota];
  }
  if (Object.keys(rows).length === 0) throw new NotPublishedError(`MI_MARGN ${yyyymmdd}`);
  return rows;
}

async function loadTpexMargin(yyyymmdd: string): Promise<Record<string, MarginRow>> {
  const payload = await fetchTpexJson<TpexTableResponse>(
    `https://www.tpex.org.tw/www/zh-tw/margin/balance?date=${tpexDateParam(yyyymmdd)}&response=json`,
    10_000
  );
  const table = payload.tables?.[0];
  const fields = table?.fields ?? [];
  const iBal = fields.indexOf("資餘額");
  const iQuota = fields.indexOf("資限額");
  if (!table?.data || table.data.length === 0) throw new NotPublishedError(`TPEx margin ${yyyymmdd}`);
  if (iBal === -1 || iQuota === -1) throw new Error("TPEx margin layout changed");
  const rows: Record<string, MarginRow> = {};
  for (const row of table.data) {
    const code = row[0]?.trim();
    const bal = parseNum(row[iBal]);
    const quota = parseNum(row[iQuota]);
    if (code && bal != null && quota != null) rows[code] = [bal, quota];
  }
  return rows;
}

function marginTable(exchange: TwHistoryExchange, yyyymmdd: string): Promise<Record<string, MarginRow>> {
  const key = `chips-history:margin:${exchange}:${yyyymmdd}:v1`;
  return cached(key, DATED_TABLE_TTL_MS, () =>
    withRetry(key, () => (exchange === "TWSE" ? loadTwseMargin(yyyymmdd) : loadTpexMargin(yyyymmdd)))
  );
}

// ---------------------------------------------------------------------------
// 外資持股比例
// ---------------------------------------------------------------------------

async function foreignHoldingPercent(exchange: TwHistoryExchange, symbol: string, yyyymmdd: string): Promise<number | undefined> {
  if (yyyymmdd >= taipeiTodayCompact()) {
    const latest = (await getForeignHoldingsBatch([symbol])).get(symbol);
    return latest && latest.date.replace(/-/g, "") === yyyymmdd ? latest.holdingPercent : undefined;
  }
  const key = `foreign-holdings:${exchange}:${yyyymmdd}`;
  return withRetry(key, async () => {
    const snap = await datedSnapshot(exchange, yyyymmdd);
    return snap.rows[symbol]?.[1];
  });
}

// ---------------------------------------------------------------------------
// 對外介面
// ---------------------------------------------------------------------------

export interface TwChipsDay {
  /** YYYY-MM-DD */
  date: string;
  /** 三大法人買賣超（股）；undefined＝那天報表抓不到（缺） */
  foreignNet?: number;
  trustNet?: number;
  dealerNet?: number;
  /** 融資餘額／融資限額（張）；只有最近 RATIO_DAYS 天會查 */
  marginBalance?: number;
  marginQuota?: number;
  /** 外資持股比例(%)；只有最近 RATIO_DAYS 天會查 */
  foreignHoldingPercent?: number;
}

function isComplete(days: TwChipsDay[]): boolean {
  return days.every((d, i) => {
    if (d.foreignNet == null) return false;
    if (i < days.length - RATIO_DAYS) return true;
    return d.marginBalance != null && d.foreignHoldingPercent != null;
  });
}

/**
 * tradingDates：ISO 日期、舊到新（呼叫端用日K線的日期），只取最後 MAX_HISTORY_DAYS 天。
 * 回傳每天一筆（同順序）；抓不到的欄位是 undefined。整個函式不會丟錯。
 * 某檔股票在已成功載入的三大法人報表裡查不到，代表那天沒有任何法人進出 → 記 0。
 */
export async function getTwChipsHistory(
  symbol: string,
  exchange: TwHistoryExchange,
  tradingDates: string[]
): Promise<TwChipsDay[]> {
  const dates = tradingDates.slice(-MAX_HISTORY_DAYS);
  if (dates.length === 0) return [];
  const summaryKey = `chips-history:symbol:${symbol}:${dates[dates.length - 1]}:${dates.length}:v1`;
  const hit = await peekCached<TwChipsDay[]>(summaryKey).catch(() => undefined);
  if (hit) return hit;

  const days: TwChipsDay[] = dates.map((date) => ({ date }));
  const ratioStart = dates.length - RATIO_DAYS;
  // 新的日子先抓：限流時最可能缺的是最舊那幾天，影響最小。
  const tasks: Array<() => Promise<void>> = [];
  for (let i = dates.length - 1; i >= 0; i--) {
    const compact = dates[i].replace(/-/g, "");
    const day = days[i];
    tasks.push(async () => {
      const table = await instiTable(exchange, compact);
      const row = table[symbol] ?? [0, 0, 0];
      [day.foreignNet, day.trustNet, day.dealerNet] = row;
    });
    if (i >= ratioStart) {
      tasks.push(async () => {
        const row = (await marginTable(exchange, compact))[symbol];
        if (row) [day.marginBalance, day.marginQuota] = row;
      });
      tasks.push(async () => {
        day.foreignHoldingPercent = await foreignHoldingPercent(exchange, symbol, compact);
      });
    }
  }
  await mapWithConcurrency(tasks, HISTORY_FETCH_CONCURRENCY, (task) => task().catch(() => undefined));

  if (isComplete(days)) await writeCached(summaryKey, days, SYMBOL_SUMMARY_TTL_MS).catch(() => undefined);
  return days;
}
