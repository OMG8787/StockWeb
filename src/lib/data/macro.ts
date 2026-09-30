import { fetchWithTimeout } from "./cache";
import { cachedWithDegradedPredicate } from "./degradedCache";
import { MACRO_SERIES, type MacroFrequency, type MacroSeriesDef } from "./macroSeries";

/**
 * FRED（美國聖路易聯準銀行）總體經濟資料——首頁「總體經濟」卡片與 AI 大盤概況共用。
 * 序列清單是純資料，放在 macroSeries.ts。
 *
 * - 金鑰只從 `process.env.FRED_API_KEY` 讀；**沒設定時 `getMacroSnapshot()` 直接回
 *   null、不發任何請求**（首頁卡片整張不顯示、AI 文字完全不加這一段，跟加這功能之前
 *   一模一樣），讓「程式先部署、使用者之後才去 Vercel 後台加金鑰」這段空窗期網站不變差。
 * - 刻意**不**加進 warm-cache 每 5 分鐘的預熱清單：總經資料一天最多變一次，靠第一個
 *   訪客觸發＋長 TTL 就夠了，不值得多吃 Vercel 免費額度。
 * - 日資料／月資料分兩包快取（各自一個 Redis key）：日資料 3 小時、月資料 12 小時；
 *   任何一項沒抓到只快取 20 分鐘，讓暫時性失敗能盡快自我修復。
 * - FRED 免費額度 120 次/分鐘，一包最多 7 個請求、每幾小時一次，完全不用擔心。
 */

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";
const DAILY_TTL_MS = 3 * 60 * 60_000;
const MONTHLY_TTL_MS = 12 * 60 * 60_000;
const DEGRADED_TTL_MS = 20 * 60_000;
/** 日資料「較約一個月前」的比較基準：往回找第一筆日期 ≤ 最新日期減 30 天的觀測值 */
const MONTH_AGO_DAYS = 30;

export interface MacroIndicator {
  /** 對應 macroSeries.ts 的 `key` */
  key: string;
  value: number;
  /** 這個數值所屬的日期（FRED observation date，YYYY-MM-DD；月資料是該月 1 日） */
  date: string;
  /** 前一筆觀測值（日資料＝前一個有資料的交易日；月資料＝上個月） */
  prevValue?: number;
  prevDate?: string;
  /** 只有日資料有：約一個月前的觀測值，讓 AI 看得到比「單日跳動」更有意義的趨勢 */
  monthAgoValue?: number;
  monthAgoDate?: string;
}

export interface MacroSnapshot {
  indicators: MacroIndicator[];
  /** 有設定金鑰但這次沒抓到的序列 key——畫面顯示「資料暫缺」、AI 照實說沒有 */
  missing: string[];
}

interface FredObservation {
  date: string;
  value: string;
}

export function isMacroConfigured(): boolean {
  return !!process.env.FRED_API_KEY;
}

async function fetchObservations(seriesId: string, limit: number): Promise<Array<{ date: string; value: number }>> {
  const apiKey = process.env.FRED_API_KEY ?? "";
  // api_key 會被 fetchWithTimeout 的錯誤訊息遮罩（redactSecretParams 已涵蓋 api_key），
  // 不會外洩到 log 或畫面上。
  const url = `${FRED_BASE}?series_id=${encodeURIComponent(seriesId)}&api_key=${encodeURIComponent(apiKey)}&file_type=json&sort_order=desc&limit=${limit}`;
  const res = await fetchWithTimeout(url, 6000);
  const data = (await res.json()) as { observations?: FredObservation[] };
  // FRED 用 "." 代表當天沒有資料（例如假日），要濾掉，不能當成 0。
  // 空字串也要擋（Number("") 會變成 0）。
  return (data.observations ?? [])
    .filter((o) => typeof o.value === "string" && o.value.trim() !== "" && o.value !== ".")
    .map((o) => ({ date: o.date, value: Number(o.value) }))
    .filter((o) => Number.isFinite(o.value) && /^\d{4}-\d{2}-\d{2}$/.test(o.date));
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 月資料往回找「剛好 N 個月前」那一筆（FRED 月資料日期固定是每月 1 日）。 */
function monthsBefore(date: string, months: number): string {
  const [y, m] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) - months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
}

async function loadSeries(def: MacroSeriesDef): Promise<MacroIndicator | null> {
  if (def.transform === "yoy") {
    // 需要最新月＋上個月，各自再對到去年同月：抓 26 筆足夠（還留空間給缺漏的月份）。
    const obs = await fetchObservations(def.seriesId, 26);
    const byDate = new Map(obs.map((o) => [o.date, o.value]));
    const yoyAt = (date: string): number | undefined => {
      const now = byDate.get(date);
      const base = byDate.get(monthsBefore(date, 12));
      return now != null && base != null && base > 0 ? round((now / base - 1) * 100, 2) : undefined;
    };
    const latest = obs[0];
    if (!latest) return null;
    const value = yoyAt(latest.date);
    if (value == null) return null;
    const prevDate = monthsBefore(latest.date, 1);
    const prevValue = yoyAt(prevDate);
    return { key: def.key, value, date: latest.date, ...(prevValue != null ? { prevValue, prevDate } : {}) };
  }

  const obs = await fetchObservations(def.seriesId, def.frequency === "daily" ? 40 : 3);
  const [latest, prev] = obs;
  if (!latest) return null;
  const indicator: MacroIndicator = { key: def.key, value: latest.value, date: latest.date };
  if (prev) {
    indicator.prevValue = prev.value;
    indicator.prevDate = prev.date;
  }
  if (def.frequency === "daily") {
    const cutoff = shiftDate(latest.date, -MONTH_AGO_DAYS);
    const monthAgo = obs.find((o) => o.date <= cutoff);
    if (monthAgo) {
      indicator.monthAgoValue = monthAgo.value;
      indicator.monthAgoDate = monthAgo.date;
    }
  }
  return indicator;
}

async function loadBundle(frequency: MacroFrequency): Promise<MacroSnapshot> {
  const defs = MACRO_SERIES.filter((d) => d.frequency === frequency);
  const results = await Promise.all(defs.map((d) => loadSeries(d).catch(() => null)));
  const indicators = results.filter((r): r is MacroIndicator => r !== null);
  const got = new Set(indicators.map((i) => i.key));
  return { indicators, missing: defs.filter((d) => !got.has(d.key)).map((d) => d.key) };
}

function getBundle(frequency: MacroFrequency): Promise<MacroSnapshot> {
  return cachedWithDegradedPredicate(
    `macro:fred:${frequency}:v1`,
    frequency === "daily" ? DAILY_TTL_MS : MONTHLY_TTL_MS,
    DEGRADED_TTL_MS,
    (snap) => snap.missing.length > 0,
    () => loadBundle(frequency)
  );
}

/**
 * 回傳 null 代表「沒設定 FRED_API_KEY」（功能整個關閉），不是抓取失敗；有設定但抓不到
 * 的項目會列在 `missing`。indicators 依 macroSeries.ts 的順序排列。永遠不會 throw。
 */
export async function getMacroSnapshot(): Promise<MacroSnapshot | null> {
  if (!isMacroConfigured()) return null;
  try {
    const [daily, monthly] = await Promise.all([getBundle("daily"), getBundle("monthly")]);
    const byKey = new Map([...daily.indicators, ...monthly.indicators].map((i) => [i.key, i]));
    return {
      indicators: MACRO_SERIES.map((d) => byKey.get(d.key)).filter((i): i is MacroIndicator => !!i),
      missing: MACRO_SERIES.filter((d) => !byKey.has(d.key)).map((d) => d.key),
    };
  } catch {
    return { indicators: [], missing: MACRO_SERIES.map((d) => d.key) };
  }
}
