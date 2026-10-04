import { cached, fetchWithTimeout, mapWithConcurrency } from "./cache";
import { cachedWithDegradedPredicate } from "./degradedCache";
import { fetchObservations, isMacroConfigured } from "./fred";
import {
  computeIndexTrend,
  computeVixContext,
  TRADING_DAYS_52W,
  type DailyClose,
  type IndexTrend,
  type VixContext,
} from "./marketHistoryStats";
import { fetchUsCandles } from "./us";

/**
 * 大盤／總體層級的「歷史脈絡」資料（AI 用的【市場歷史與情緒走勢】區塊）——
 * 計算在 marketHistoryStats.ts（純函式），文字在 lib/ai/marketHistoryText.ts。
 *
 * 資料來源（2026-10-04 實際打過確認格式）：
 * - 加權指數＋美股三大指數：Yahoo 日K（^TWII／^GSPC／^IXIC／^SOX，1年）。
 * - 櫃買指數：Yahoo 沒有（^TWO、^TWOII 都 404），改用 TPEx 官網「櫃買指數月查詢」，
 *   一個月一個請求、往回 13 個月。
 * - 三大法人（上市大盤合計）：TWSE BFI82U，一天一個請求（金額，元）。
 * - 上市融資餘額：TWSE MI_MARGN selectType=MS（彙總表的「融資金額(仟元)」列）。
 * - VIX：FRED VIXCLS 近3個月序列（跟 macro.ts 同一把金鑰；沒設定就整段略過）。
 *
 * 防限流（見 PROGRESS.md 常見雷區：TWSE 對 Vercel 出口 IP 連續請求會回 428/503）：
 * - 已收盤的交易日／月份資料不會再變 → 單日／單月各自一個快取 key（含日期）、長 TTL；
 *   之後每天只會多打「新的那一天」。
 * - TWSE、TPEx 請求併發 ≤3、每個請求失敗重試 3 次並退避（同 twse.ts fetchMonthResilient）。
 * - 抓不到（含當天盤後資料還沒公布）一律 throw → `cached()` 不會快取失敗；該日在
 *   結果裡就是缺，整體不受影響。
 * - 整包組好的結果再快取 30 分鐘（有缺項只快取 5 分鐘），AI 呼叫頻繁時也不會每次都
 *   重新組裝；每一段另有時間上限，冷啟動慢的段落直接略過，不拖慢 AI 回答。
 */

const INDEX_DEFS: Array<{ key: string; name: string; market: "TW" | "US"; yahoo?: string }> = [
  { key: "taiex", name: "加權指數", market: "TW", yahoo: "^TWII" },
  { key: "tpex", name: "櫃買指數", market: "TW" },
  { key: "spx", name: "S&P 500", market: "US", yahoo: "^GSPC" },
  { key: "nasdaq", name: "那斯達克", market: "US", yahoo: "^IXIC" },
  { key: "sox", name: "費城半導體", market: "US", yahoo: "^SOX" },
];

const UPSTREAM_CONCURRENCY = 3;
const RETRY_ATTEMPTS = 3;
/** 已收盤交易日的法人／融資資料、已結束月份的櫃買指數：不會再變 */
const CLOSED_DATA_TTL_MS = 7 * 24 * 60 * 60_000;
/** 本月的櫃買指數月表（每天會多一筆） */
const OPEN_MONTH_TTL_MS = 30 * 60_000;
/** Yahoo 日K（含盤中最新一根）與 FRED VIX */
const CANDLES_TTL_MS = 60 * 60_000;
const BUNDLE_TTL_MS = 30 * 60_000;
const BUNDLE_DEGRADED_TTL_MS = 5 * 60_000;
/** 每一段的時間上限；超過就當這段缺（背景抓到的結果仍會寫進快取給下一次用） */
const PART_TIME_BUDGET_MS = 8000;
/** 法人看近 10 個交易日、融資看近 6 個交易日（算近5日增減） */
export const INSTITUTIONAL_DAYS = 10;
export const MARGIN_DAYS = 6;

export interface InstitutionalDay {
  /** YYYY-MM-DD */
  date: string;
  /** 以下皆為買賣超金額，單位：億元 */
  foreign: number;
  trust: number;
  dealer: number;
  total: number;
}

export interface MarginDay {
  date: string;
  /** 上市融資餘額（億元） */
  balance: number;
}

export interface MarketHistory {
  indices: IndexTrend[];
  /** 由新到舊；只含抓到的交易日 */
  institutional: InstitutionalDay[];
  /** 預期要有、但抓不到的交易日（例如當天盤後資料還沒公布） */
  institutionalMissing: string[];
  /** 由新到舊 */
  margin: MarginDay[];
  vix: VixContext | null;
}

function taipeiToday(): string {
  return new Date(Date.now() + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

function taipeiHour(): number {
  return new Date(Date.now() + 8 * 60 * 60_000).getUTCHours();
}

/** TWSE 當天盤後資料的公布時間（台北）：三大法人約 15:00、融資融券約晚上 21:00 後。
 *  還沒到時間就不去抓「今天」，免得每次都多打一個必定失敗的請求、也不會被算成缺漏。 */
const BFI82U_PUBLISH_HOUR = 15;
const MARGIN_PUBLISH_HOUR = 22;

function excludeUnpublishedToday(datesNewestFirst: string[], publishHour: number): string[] {
  return datesNewestFirst[0] === taipeiToday() && taipeiHour() < publishHour ? datesNewestFirst.slice(1) : datesNewestFirst;
}

function compact(date: string): string {
  return date.replace(/-/g, "");
}

async function withRetry<T>(load: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await load();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1) + Math.random() * 300));
      }
    }
  }
  throw lastErr;
}

function withBudget<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), PART_TIME_BUDGET_MS)),
  ]);
}

function num(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : undefined;
}

// ---------- 指數日K ----------

async function loadYahooCloses(symbol: string): Promise<DailyClose[]> {
  return cached(`mkthist:yahoo:${symbol}:${taipeiToday()}:v1`, CANDLES_TTL_MS, async () => {
    const candles = await withRetry(() => fetchUsCandles(symbol, "1y"));
    return candles.map((c) => ({ date: c.time.slice(0, 10), close: c.close, high: c.high }));
  });
}

interface TpexIndexResponse {
  stat?: string;
  tables?: Array<{ fields?: string[]; data?: string[][] }>;
}

async function loadTpexMonth(year: number, month: number, closed: boolean): Promise<DailyClose[]> {
  const ym = `${year}/${String(month).padStart(2, "0")}`;
  const key = closed ? `mkthist:tpexidx:${ym}:v1` : `mkthist:tpexidx:${ym}:${taipeiToday()}:v1`;
  return cached(key, closed ? CLOSED_DATA_TTL_MS : OPEN_MONTH_TTL_MS, () =>
    withRetry(async () => {
      const url = `https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=${encodeURIComponent(`${ym}/01`)}&response=json`;
      const res = await fetchWithTimeout(url, 6000);
      const payload = (await res.json()) as TpexIndexResponse;
      const table = payload.tables?.[0];
      if (payload.stat?.toLowerCase() !== "ok" || !table?.fields || !table.data) throw new Error(`TPEx index ${ym}: no data`);
      const iDate = table.fields.indexOf("日期");
      const iHigh = table.fields.indexOf("最高");
      const iClose = table.fields.indexOf("收市");
      if (iDate === -1 || iClose === -1) throw new Error(`TPEx index ${ym}: unexpected fields`);
      const rows: DailyClose[] = [];
      for (const row of table.data) {
        const date = row[iDate]?.replace(/\//g, "-");
        const close = num(row[iClose]);
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || close == null || close <= 0) continue;
        rows.push({ date, close, high: iHigh === -1 ? undefined : num(row[iHigh]) });
      }
      // 月初第一個交易日前（例如 1 號是假日）本月表可能是空的——當成正常的空月，不算失敗
      if (rows.length === 0 && closed) throw new Error(`TPEx index ${ym}: empty`);
      return rows;
    })
  );
}

async function loadTpexCloses(): Promise<DailyClose[]> {
  const [y, m] = taipeiToday().split("-").map(Number);
  // 往回 13 個月才蓋得到 52 週
  const months = Array.from({ length: 13 }, (_, i) => {
    const total = y * 12 + (m - 1) - i;
    return { year: Math.floor(total / 12), month: (total % 12) + 1, closed: i > 0 };
  });
  const results = await mapWithConcurrency(months, UPSTREAM_CONCURRENCY, (mo) =>
    loadTpexMonth(mo.year, mo.month, mo.closed).catch(() => null)
  );
  // 最近 4 個月（算 3 個月報酬與均線必需）任何一個缺就整檔放棄，不拿斷掉的序列硬算
  if (results.slice(0, 4).some((r) => r === null)) throw new Error("TPEx index: recent months missing");
  return results
    .filter((r): r is DailyClose[] => r !== null)
    .flat()
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-TRADING_DAYS_52W - 5);
}

async function loadIndexTrends(): Promise<{ trends: IndexTrend[]; taiexDates: string[] }> {
  let taiexDates: string[] = [];
  const trends = await Promise.all(
    INDEX_DEFS.map(async (def) => {
      try {
        const closes = def.yahoo ? await loadYahooCloses(def.yahoo) : await loadTpexCloses();
        if (def.key === "taiex") taiexDates = closes.map((c) => c.date);
        return computeIndexTrend(def, closes);
      } catch {
        return null;
      }
    })
  );
  return { trends: trends.filter((t): t is IndexTrend => t !== null), taiexDates };
}

// ---------- 台股法人／融資（逐日） ----------

interface Bfi82uResponse {
  stat?: string;
  date?: string;
  data?: string[][];
}

async function loadInstitutionalDay(date: string): Promise<InstitutionalDay> {
  return cached(`mkthist:bfi82u:${compact(date)}:v1`, CLOSED_DATA_TTL_MS, () =>
    withRetry(async () => {
      const url = `https://www.twse.com.tw/rwd/zh/fund/BFI82U?response=json&dayDate=${compact(date)}&type=day`;
      const res = await fetchWithTimeout(url, 6000);
      const payload = (await res.json()) as Bfi82uResponse;
      if (payload.stat !== "OK" || !payload.data || payload.date !== compact(date)) {
        throw new Error(`BFI82U ${date}: no data`);
      }
      const net = (label: string) => {
        const row = payload.data!.find((r) => r[0]?.trim() === label);
        return row ? num(row[3]) : undefined;
      };
      const foreign = net("外資及陸資(不含外資自營商)");
      const total = net("合計");
      const trust = net("投信");
      if (foreign == null || total == null || trust == null) throw new Error(`BFI82U ${date}: unexpected rows`);
      const yi = (v: number) => Math.round(v / 1e6) / 100;
      return {
        date,
        foreign: yi(foreign + (net("外資自營商") ?? 0)),
        trust: yi(trust),
        dealer: yi((net("自營商(自行買賣)") ?? 0) + (net("自營商(避險)") ?? 0)),
        total: yi(total),
      };
    })
  );
}

interface MiMargnSummaryResponse {
  stat?: string;
  date?: string;
  tables?: Array<{ fields?: string[]; data?: string[][] }>;
}

async function loadMarginDay(date: string): Promise<MarginDay> {
  return cached(`mkthist:margin-ms:${compact(date)}:v1`, CLOSED_DATA_TTL_MS, () =>
    withRetry(async () => {
      const url = `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date=${compact(date)}&selectType=MS`;
      const res = await fetchWithTimeout(url, 8000);
      const payload = (await res.json()) as MiMargnSummaryResponse;
      if (payload.stat !== "OK" || payload.date !== compact(date)) throw new Error(`MI_MARGN ${date}: no data`);
      const table = payload.tables?.find((t) => t.fields?.includes("今日餘額"));
      const iToday = table?.fields?.indexOf("今日餘額") ?? -1;
      const row = table?.data?.find((r) => r[0]?.startsWith("融資金額"));
      const balance = row && iToday !== -1 ? num(row[iToday]) : undefined;
      if (balance == null || balance <= 0) throw new Error(`MI_MARGN ${date}: no margin row`);
      // 單位仟元 → 億元
      return { date, balance: Math.round(balance / 1e3) / 100 };
    })
  );
}

/** 沒有加權指數日K可對交易日時的退路：從今天往回列平日（國定假日會抓不到、標缺，不影響其他天） */
function recentWeekdays(count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${taipeiToday()}T00:00:00Z`);
  while (out.length < count) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

async function loadTwChipsHistory(
  tradingDatesNewestFirst: string[]
): Promise<{ institutional: InstitutionalDay[]; institutionalMissing: string[]; margin: MarginDay[] }> {
  const instDates = excludeUnpublishedToday(tradingDatesNewestFirst, BFI82U_PUBLISH_HOUR).slice(0, INSTITUTIONAL_DAYS);
  const marginDates = excludeUnpublishedToday(tradingDatesNewestFirst, MARGIN_PUBLISH_HOUR).slice(0, MARGIN_DAYS);
  // 法人跟融資共用同一個併發上限：兩者打的是同一台 www.twse.com.tw
  const tasks: Array<() => Promise<InstitutionalDay | MarginDay | null>> = [
    ...instDates.map((d) => () => loadInstitutionalDay(d).catch(() => null)),
    ...marginDates.map((d) => () => loadMarginDay(d).catch(() => null)),
  ];
  const results = await mapWithConcurrency(tasks, UPSTREAM_CONCURRENCY, (t) => t());
  const inst = results.slice(0, instDates.length) as Array<InstitutionalDay | null>;
  const margin = results.slice(instDates.length) as Array<MarginDay | null>;
  return {
    institutional: inst.filter((r): r is InstitutionalDay => r !== null),
    institutionalMissing: instDates.filter((_, i) => inst[i] === null),
    margin: margin.filter((r): r is MarginDay => r !== null),
  };
}

// ---------- VIX ----------

async function loadVix(): Promise<VixContext | null> {
  if (!isMacroConfigured()) return null;
  const obs = await cached(`mkthist:fred:vix:${taipeiToday()}:v1`, CANDLES_TTL_MS, () =>
    withRetry(() => fetchObservations("VIXCLS", 80))
  );
  return computeVixContext(obs);
}

// ---------- 組裝 ----------

async function loadMarketHistory(): Promise<MarketHistory> {
  const indexPart = withBudget(loadIndexTrends(), { trends: [], taiexDates: [] });
  const vixPart = withBudget(loadVix(), null);
  const chipsPart = indexPart.then(({ taiexDates }) => {
    // 加權指數日K的日期就是實際交易日；Yahoo 盤中會先出現今天這根，當天盤後的法人／
    // 融資資料要到下午才公布，那一天抓不到就標缺。
    const dates = taiexDates.length > 0 ? taiexDates.slice(-(INSTITUTIONAL_DAYS + 1)).reverse() : recentWeekdays(INSTITUTIONAL_DAYS + 3);
    return withBudget(loadTwChipsHistory(dates), { institutional: [], institutionalMissing: [], margin: [] });
  });
  const [{ trends }, vix, chips] = await Promise.all([indexPart, vixPart, chipsPart]);
  return { indices: trends, vix, ...chips };
}

function isDegraded(h: MarketHistory): boolean {
  return (
    h.indices.length < INDEX_DEFS.length ||
    h.institutional.length < INSTITUTIONAL_DAYS ||
    h.margin.length < MARGIN_DAYS ||
    (isMacroConfigured() && h.vix === null)
  );
}

/** 永遠不會 throw；抓不到的部分就是空陣列／null。 */
export async function getMarketHistory(): Promise<MarketHistory> {
  try {
    return await cachedWithDegradedPredicate(
      `mkthist:bundle:${taipeiToday()}:v1`,
      BUNDLE_TTL_MS,
      BUNDLE_DEGRADED_TTL_MS,
      isDegraded,
      loadMarketHistory
    );
  } catch {
    return { indices: [], institutional: [], institutionalMissing: [], margin: [], vix: null };
  }
}
