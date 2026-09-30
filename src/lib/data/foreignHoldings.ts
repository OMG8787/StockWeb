import { cached, fetchWithTimeout } from "./cache";
import { fetchTpexJson } from "./tpex";

/**
 * 外資持股比例（全體外資及陸資持股比率）——上市走 TWSE、上櫃走 TPEx，兩邊都是
 * 「全市場一次回傳、每個交易日收盤後公布一次」的報表，而且兩邊都支援用日期參數
 * 查指定交易日，所以「較前一交易日增減」直接查前一交易日的官方報表算，不用自己
 * 另存快照（2026-09-30 實測確認）：
 *   - TWSE：www.twse.com.tw/rwd/zh/fund/MI_QFIIS?selectType=ALLBUT0999&date=YYYYMMDD
 *     非交易日回 stat=OK 但沒有 data 欄位。
 *   - TPEx：www.tpex.org.tw/www/zh-tw/insti/qfii?date=YYYY/MM/DD（openapi 的
 *     tpex_3insti_qfii 只有最新一天、不能查歷史，所以改用官網頁面背後的這支 JSON）。
 *     非交易日回 totalCount=0。
 * 興櫃不在任何一份清單裡（櫃買中心沒有公布），查不到就是 undefined →「資料暫缺」。
 *
 * 快取策略（Vercel/Upstash 免費額度吃緊）：「最新一天」整包快取 1 小時；過去日期
 * 的報表內容不會再變，依日期各自快取 7 天，所以每小時重算最多只多打 1 次上游。
 * 每檔只存 [持有股數, 持股比率] 兩個數字，避免 Redis payload 過大。
 */

type Exchange = "TWSE" | "TPEX";

/** [全體外資及陸資持有股數(股), 持股比率(%)] */
type HoldingRow = [number, number];

interface HoldingSnapshot {
  /** YYYYMMDD；非交易日（或查無資料）時仍是查詢的日期，rows 為空 */
  date: string;
  rows: Record<string, HoldingRow>;
}

const LATEST_TTL_MS = 60 * 60_000;
const DATED_TTL_MS = 7 * 24 * 60 * 60_000;
/** 往回找前一交易日最多找幾個平日——涵蓋春節這種最長連假還有餘。 */
const MAX_LOOKBACK_WEEKDAYS = 10;

function num(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const n = parseFloat(raw.replace(/[,%\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

interface TwseQfiisResponse {
  stat?: string;
  date?: string;
  fields?: string[];
  data?: Array<Array<string | number>>;
}

async function fetchTwseSnapshot(date?: string): Promise<HoldingSnapshot> {
  const url = `https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS?response=json&selectType=ALLBUT0999&date=${date ?? ""}`;
  const res = await fetchWithTimeout(url, 10_000);
  const payload = (await res.json()) as TwseQfiisResponse;
  // stat 不是 OK（例如被限流回錯誤訊息）要丟錯、不能當成「這天沒資料」——否則會被
  // 依日期長效快取成空的，前一交易日就會被錯誤地跳到更早的一天。
  if (payload.stat !== "OK") throw new Error(`TWSE MI_QFIIS stat=${payload.stat}`);
  const snapshot: HoldingSnapshot = { date: payload.date ?? date ?? "", rows: {} };
  const fields = payload.fields ?? [];
  const iCode = fields.indexOf("證券代號");
  const iHeld = fields.indexOf("全體外資及陸資持有股數");
  const iPct = fields.indexOf("全體外資及陸資持股比率");
  if (!payload.data || iCode === -1 || iHeld === -1 || iPct === -1) return snapshot;
  for (const row of payload.data) {
    const code = String(row[iCode] ?? "").trim();
    const held = num(row[iHeld]);
    const pct = num(row[iPct]);
    if (code && held != null && pct != null) snapshot.rows[code] = [held, pct];
  }
  return snapshot;
}

interface TpexQfiiResponse {
  tables?: Array<{ date?: string; totalCount?: number; fields?: string[]; data?: string[][] }>;
}

async function fetchTpexSnapshot(date?: string): Promise<HoldingSnapshot> {
  const dateParam = date ? `&date=${date.slice(0, 4)}%2F${date.slice(4, 6)}%2F${date.slice(6, 8)}` : "";
  const payload = await fetchTpexJson<TpexQfiiResponse>(
    `https://www.tpex.org.tw/www/zh-tw/insti/qfii?response=json${dateParam}`,
    10_000
  );
  const table = payload.tables?.[0];
  if (!table) throw new Error("TPEx qfii: unexpected payload");
  // 回傳日期是民國年 "115/09/29"
  const roc = table.date?.match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
  const resolvedDate = roc ? `${parseInt(roc[1], 10) + 1911}${roc[2]}${roc[3]}` : (date ?? "");
  const snapshot: HoldingSnapshot = { date: resolvedDate, rows: {} };
  const fields = table.fields ?? [];
  const iCode = fields.indexOf("代號");
  const iHeld = fields.findIndex((f) => f.includes("持有股數"));
  const iPct = fields.findIndex((f) => f.includes("持股比率"));
  if (!table.data || iCode === -1 || iHeld === -1 || iPct === -1) return snapshot;
  for (const row of table.data) {
    const code = row[iCode]?.trim();
    const held = num(row[iHeld]);
    const pct = num(row[iPct]);
    if (code && held != null && pct != null) snapshot.rows[code] = [held, pct];
  }
  return snapshot;
}

const FETCHERS: Record<Exchange, (date?: string) => Promise<HoldingSnapshot>> = {
  TWSE: fetchTwseSnapshot,
  TPEX: fetchTpexSnapshot,
};

function latestSnapshot(exchange: Exchange): Promise<HoldingSnapshot> {
  return cached(`foreign-holdings:${exchange}:latest:v1`, LATEST_TTL_MS, () => FETCHERS[exchange]());
}

function datedSnapshot(exchange: Exchange, yyyymmdd: string): Promise<HoldingSnapshot> {
  return cached(`foreign-holdings:${exchange}:${yyyymmdd}:v1`, DATED_TTL_MS, () => FETCHERS[exchange](yyyymmdd));
}

function toUtcDate(yyyymmdd: string): Date {
  return new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)));
}

function fromUtcDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

export function yyyymmddToIso(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** 從 latestDate 的前一天開始往回找第一個「有資料」的交易日（跳過週末不打上游）。 */
async function previousTradingSnapshot(exchange: Exchange, latestDate: string): Promise<HoldingSnapshot | undefined> {
  const cursor = toUtcDate(latestDate);
  let weekdaysTried = 0;
  while (weekdaysTried < MAX_LOOKBACK_WEEKDAYS) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const wd = cursor.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    weekdaysTried++;
    const snap = await datedSnapshot(exchange, fromUtcDate(cursor));
    if (Object.keys(snap.rows).length > 0) return snap;
  }
  return undefined;
}

export interface ForeignHolding {
  date: string;
  heldShares: number;
  holdingPercent: number;
  prevDate?: string;
  prevHeldShares?: number;
  prevHoldingPercent?: number;
}

/**
 * 多檔一次查（股票列表的籌碼比例欄位用）：只讀全市場整包快取（每個交易所的最新＋
 * 前一交易日各一份），在記憶體裡查表，不會對每檔各打一次上游。只有清單裡真的
 * 出現某個交易所的股票時，才去讀那個交易所的前一交易日報表。回傳的 Map 只含查得
 * 到的代號；查不到的（興櫃、美股等）不在 Map 裡。
 */
export async function getForeignHoldingsBatch(symbols: string[]): Promise<Map<string, ForeignHolding>> {
  const out = new Map<string, ForeignHolding>();
  if (symbols.length === 0) return out;
  const [twse, tpex] = await Promise.all([
    latestSnapshot("TWSE").catch(() => undefined),
    latestSnapshot("TPEX").catch(() => undefined),
  ]);
  const latestBy: Record<Exchange, HoldingSnapshot | undefined> = { TWSE: twse, TPEX: tpex };
  const exchangeOf = (symbol: string): Exchange | undefined =>
    twse?.rows[symbol] ? "TWSE" : tpex?.rows[symbol] ? "TPEX" : undefined;

  const needed = new Set(symbols.map(exchangeOf).filter((e): e is Exchange => e != null));
  // 前一交易日抓不到只影響「增減」那一欄，不能讓整個外資持股一起消失。
  const prevBy: Partial<Record<Exchange, HoldingSnapshot | undefined>> = {};
  await Promise.all(
    Array.from(needed, async (exchange) => {
      prevBy[exchange] = await previousTradingSnapshot(exchange, latestBy[exchange]!.date).catch(() => undefined);
    })
  );

  for (const symbol of symbols) {
    const exchange = exchangeOf(symbol);
    const latest = exchange ? latestBy[exchange] : undefined;
    if (!exchange || !latest) continue;
    const [heldShares, holdingPercent] = latest.rows[symbol];
    const result: ForeignHolding = { date: yyyymmddToIso(latest.date), heldShares, holdingPercent };
    const prev = prevBy[exchange];
    const prevRow = prev?.rows[symbol];
    if (prev && prevRow) {
      result.prevDate = yyyymmddToIso(prev.date);
      [result.prevHeldShares, result.prevHoldingPercent] = prevRow;
    }
    out.set(symbol, result);
  }
  return out;
}

/** 上市/上櫃個股的外資持股比例＋前一交易日；兩邊都查不到回 undefined（興櫃、ETF 以外的特殊代號等）。
 *  與列表用的批次版走同一套邏輯，確保個股頁與列表數字一致。 */
export async function getForeignHolding(symbol: string): Promise<ForeignHolding | undefined> {
  return (await getForeignHoldingsBatch([symbol])).get(symbol);
}
