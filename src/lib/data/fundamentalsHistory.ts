import { cached, fetchWithTimeout } from "./cache";
import { fetchUsQuarterlyEpsHistory } from "./us";

/**
 * 基本面多期趨勢（AI 問答【歷史脈絡】用，見 ai/grounding/history.ts）。
 *
 * 台股：官方 OpenAPI（t187ap05_L 月營收、t187ap06_L_ci 季報）都只有「最新一期」，要
 * 多期就得逐月/逐季抓全市場整包，太重。改用 Yahoo奇摩股市個股頁內嵌的 JSON（跟
 * yahooTwMarketDepth.ts 同一個來源家族，2026-10-04 實測）：
 *   - /quote/<代號>.TW(O)/revenue → "revenueChart-<代號>.TW-month":{"data":[{date:"2026/08",
 *     currentPeriodRevenue(千元), revenueYoY:"53.32"}...]}，約 60 個月
 *   - /quote/<代號>.TW(O)/eps     → "epsChart-<代號>.TW-quarter...":{"data":[{date:"2026 Q2", eps}...]}，約 20 季
 * 一檔各 1 個請求（約 440KB HTML），所以只給「使用者正在問的那幾檔」用，依代號＋台北日期
 * 快取 12 小時，只存需要的幾個數字。非官方頁面結構，改版時抓不到就是 undefined（fail open）。
 * 美股：Yahoo quoteSummary earnings 模組的近 4 季 EPS（見 us.ts）。
 */

export const REVENUE_MONTHS = 12;
export const EPS_QUARTERS = 8;
const HISTORY_TTL_MS = 12 * 60 * 60_000;
const YAHOO_TW_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface RevenuePoint {
  /** "2026/08" */
  period: string;
  /** 千元 */
  revenue: number;
  yoyPercent?: number;
}

export interface EpsPoint {
  /** 台股 "2026 Q2"；美股 Yahoo 的財報季標籤（例如 "2Q2026"） */
  period: string;
  eps: number;
}

export interface FundamentalsHistory {
  /** 舊到新 */
  revenue: RevenuePoint[];
  /** 舊到新 */
  eps: EpsPoint[];
  source: string;
}

function taipeiDateCompact(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date()).replace(/-/g, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 從頁面原始碼挖出 `"<keyPrefix>...":{"data":[...]}` 那個陣列（陣列元素是不含巢狀陣列的平面物件）。 */
function extractDataArray(html: string, keyPattern: string): Array<Record<string, unknown>> | undefined {
  const m = html.match(new RegExp(`"${keyPattern}":\\{"data":(\\[[^\\]]*\\])`));
  if (!m) return undefined;
  try {
    const parsed = JSON.parse(m[1]) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : undefined;
  } catch {
    return undefined;
  }
}

function toNum(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

async function fetchYahooTwPage(yahooSymbol: string, tab: "revenue" | "eps"): Promise<string> {
  const res = await fetchWithTimeout(`https://tw.stock.yahoo.com/quote/${yahooSymbol}/${tab}`, 8000, {
    headers: { "User-Agent": YAHOO_TW_UA, "Accept-Language": "zh-TW" },
  });
  return res.text();
}

async function loadYahooTw(yahooSymbol: string): Promise<{ revenue: RevenuePoint[]; eps: EpsPoint[] }> {
  const esc = escapeRegExp(yahooSymbol);
  const [revHtml, epsHtml] = await Promise.all([
    fetchYahooTwPage(yahooSymbol, "revenue").catch(() => ""),
    fetchYahooTwPage(yahooSymbol, "eps").catch(() => ""),
  ]);
  const revenue = (extractDataArray(revHtml, `revenueChart-${esc}-month`) ?? [])
    .flatMap((r): RevenuePoint[] => {
      const revenueValue = toNum(r.currentPeriodRevenue);
      if (typeof r.date !== "string" || revenueValue == null) return [];
      const yoy = toNum(r.revenueYoY);
      return [{ period: r.date, revenue: revenueValue, yoyPercent: yoy != null ? Math.round(yoy * 100) / 100 : undefined }];
    })
    .slice(-REVENUE_MONTHS);
  const eps = (extractDataArray(epsHtml, `epsChart-${esc}-quarter[^"]*`) ?? [])
    .flatMap((r): EpsPoint[] => {
      const v = toNum(r.eps);
      return typeof r.date === "string" && v != null ? [{ period: r.date, eps: v }] : [];
    })
    .slice(-EPS_QUARTERS);
  return { revenue, eps };
}

/**
 * 台股月營收（近 REVENUE_MONTHS 個月）＋季 EPS（近 EPS_QUARTERS 季）。exchange 不確定時
 * 兩個 Yahoo 後綴都試（興櫃在 Yahoo 跟上櫃共用 .TWO）。兩項都抓不到回 null（不快取，下次再試）。
 */
export async function getTwFundamentalsHistory(
  symbol: string,
  exchange: "TWSE" | "TPEx" | "Emerging" | undefined
): Promise<FundamentalsHistory | null> {
  const suffixes = exchange === "TWSE" ? ["TW"] : exchange ? ["TWO"] : ["TW", "TWO"];
  try {
    return await cached(`fundamentals-history:TW:${symbol}:${taipeiDateCompact()}:v1`, HISTORY_TTL_MS, async () => {
      for (const suffix of suffixes) {
        const data = await loadYahooTw(`${symbol}.${suffix}`);
        if (data.revenue.length > 0 || data.eps.length > 0) return { ...data, source: "Yahoo奇摩股市" };
      }
      throw new Error(`no Yahoo TW fundamentals history for ${symbol}`);
    });
  } catch {
    return null;
  }
}

/** 美股近幾季 EPS（Yahoo 通常給 4 季）；抓不到回 null。美股月營收不是公開揭露項目，沒有。 */
export async function getUsFundamentalsHistory(symbol: string): Promise<FundamentalsHistory | null> {
  try {
    return await cached(`fundamentals-history:US:${symbol}:${taipeiDateCompact()}:v1`, HISTORY_TTL_MS, async () => {
      const eps = await fetchUsQuarterlyEpsHistory(symbol);
      if (eps.length === 0) throw new Error(`no US EPS history for ${symbol}`);
      return { revenue: [], eps, source: "Yahoo Finance" };
    });
  } catch {
    return null;
  }
}
