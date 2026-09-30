import { cached, fetchWithTimeout } from "./cache";
import type { NewsItem } from "./news";
import type { Earnings, Fundamentals } from "./types";

/**
 * Finnhub（https://finnhub.io）美股資料——**只當 Yahoo 非官方端點失敗時的備援**，
 * 加上美股個股新聞的補充來源。台股 Finnhub 免費版沒有資料（實測 2330.TW 回 403），
 * 這裡一律只處理美股。
 *
 * 為什麼是「Yahoo 為主、Finnhub 備援」而不是反過來（2026-09-30 實測決定）：
 * - Yahoo 目前 AAPL/PLTR 財報與基本面都正常，而且兩邊的「最新一季 EPS」口徑不同
 *   （同一天 AAPL：Yahoo 2.02、Finnhub 1.91，推測一邊是調整後 EPS），直接換成
 *   Finnhub 為主會讓既有頁面的數字無預警改變；
 * - Finnhub 免費額度 60 次/分鐘（實測回應標頭 x-ratelimit-limit=60，同時連打 30 次
 *   全部 200），只在 Yahoo 失敗時才用，額度幾乎不會碰到。
 *
 * 金鑰只從 `process.env.FINNHUB_API_KEY` 讀，走 `X-Finnhub-Token` 標頭（不放 URL，
 * 錯誤訊息裡的網址就不會帶到金鑰）。沒設定時 `isFinnhubConfigured()` 為 false，
 * 呼叫端完全不會打 Finnhub，行為跟加這功能之前一模一樣。
 */

const FINNHUB_BASE = "https://finnhub.io/api/v1";
const COMPANY_NEWS_TTL_MS = 30 * 60_000;
const COMPANY_NEWS_LOOKBACK_DAYS = 7;
/** 查下次財報日往後看多遠（大部分公司一季一次，120 天一定涵蓋得到下一次） */
const NEXT_EARNINGS_LOOKAHEAD_DAYS = 120;

export function isFinnhubConfigured(): boolean {
  return !!process.env.FINNHUB_API_KEY;
}

async function finnhubGet<T>(path: string, timeoutMs = 5000): Promise<T> {
  const res = await fetchWithTimeout(`${FINNHUB_BASE}${path}`, timeoutMs, {
    headers: { "X-Finnhub-Token": process.env.FINNHUB_API_KEY ?? "", Accept: "application/json" },
  });
  return (await res.json()) as T;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function positive(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

interface FinnhubEarningsRow {
  actual: number | null;
  estimate: number | null;
  period: string; // 季底日期，例如 "2026-06-30"
  quarter: number; // 公司自己的會計年度季別（Apple 6 月底那季是 FY Q3）
  year: number;
  surprisePercent: number | null;
}

interface FinnhubEarningsCalendar {
  earningsCalendar?: Array<{ date: string; symbol: string }>;
}

/**
 * 對齊 `Earnings` 型別：最新一季實際 EPS、相對市場預期的驚喜幅度、下次財報日。
 * 季別標示成 "FY2026 Q3"——Finnhub 給的是公司會計年度，跟 Yahoo 的 "2Q2026" 標法
 * 不同，加 FY 前綴讓讀者知道這是會計年度季別。兩個端點並行打（共 2 次額度）。
 */
export async function fetchFinnhubEarnings(symbol: string): Promise<Earnings | null> {
  const sym = encodeURIComponent(symbol);
  const [rows, calendar] = await Promise.all([
    finnhubGet<FinnhubEarningsRow[]>(`/stock/earnings?symbol=${sym}`),
    finnhubGet<FinnhubEarningsCalendar>(
      `/calendar/earnings?symbol=${sym}&from=${isoDate(0)}&to=${isoDate(NEXT_EARNINGS_LOOKAHEAD_DAYS)}`
    ).catch(() => ({}) as FinnhubEarningsCalendar),
  ]);
  const today = isoDate(0);
  const nextEarningsDate = (calendar.earningsCalendar ?? [])
    .map((e) => e.date)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today)
    .sort()[0];
  const latest = (Array.isArray(rows) ? rows : [])
    .filter((r) => typeof r.actual === "number" && Number.isFinite(r.actual))
    .sort((a, b) => b.period.localeCompare(a.period))[0];
  if (!latest) return nextEarningsDate ? { nextEarningsDate } : null;
  return {
    quarterlyEps: round2(latest.actual as number),
    quarterlyEpsPeriod: `FY${latest.year} Q${latest.quarter}`,
    epsSurprisePercent:
      typeof latest.surprisePercent === "number" && Number.isFinite(latest.surprisePercent)
        ? round2(latest.surprisePercent)
        : undefined,
    nextEarningsDate,
  };
}

interface FinnhubMetricResponse {
  metric?: Record<string, number | null | undefined>;
}

/**
 * 對齊 `Fundamentals` 型別。Finnhub 的市值單位是「百萬美元」、殖利率已經是百分比
 * （AAPL 0.32 代表 0.32%，跟 Yahoo 換算後一致），這裡換算成跟 Yahoo 版相同的單位。
 * 注意 Finnhub 的本益比等是每日收盤後更新，不像 Yahoo 盤中隨價格即時變動。
 */
export async function fetchFinnhubFundamentals(symbol: string): Promise<Fundamentals | null> {
  const data = await finnhubGet<FinnhubMetricResponse>(`/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all`);
  const m = data.metric ?? {};
  const pe = positive(m.peTTM) ?? positive(m.peBasicExclExtraTTM);
  const pb = positive(m.pbQuarterly) ?? positive(m.pbAnnual);
  const dy = positive(m.currentDividendYieldTTM);
  const capMillions = positive(m.marketCapitalization);
  const result: Fundamentals = {
    peRatio: pe != null ? round2(pe) : undefined,
    pbRatio: pb != null ? round2(pb) : undefined,
    dividendYield: dy != null ? round2(dy) : undefined,
    marketCap: capMillions != null ? Math.round(capMillions * 1_000_000) : undefined,
  };
  return Object.values(result).some((v) => v != null) ? result : null;
}

interface FinnhubNewsRow {
  datetime: number; // UNIX 秒
  headline: string;
  source: string;
  url: string;
}

/**
 * 美股個股近 7 天新聞（補在 Google News 之外，Google News RSS 失敗時也還有新聞可用）。
 * 沒設定金鑰或抓失敗一律回空陣列，不 throw。快取 30 分鐘。
 */
export async function fetchFinnhubCompanyNews(symbol: string, limit: number): Promise<NewsItem[]> {
  if (!isFinnhubConfigured()) return [];
  try {
    return await cached(`news:finnhub:${symbol}:${limit}`, COMPANY_NEWS_TTL_MS, async () => {
      const rows = await finnhubGet<FinnhubNewsRow[]>(
        `/company-news?symbol=${encodeURIComponent(symbol)}&from=${isoDate(-COMPANY_NEWS_LOOKBACK_DAYS)}&to=${isoDate(0)}`
      );
      return (Array.isArray(rows) ? rows : [])
        .filter((r) => r.headline && Number.isFinite(r.datetime))
        .sort((a, b) => b.datetime - a.datetime)
        .slice(0, limit)
        .map((r) => ({
          title: r.headline.trim(),
          source: r.source || undefined,
          pubDate: new Date(r.datetime * 1000).toISOString(),
          link: r.url || undefined,
        }));
    });
  } catch {
    return [];
  }
}
