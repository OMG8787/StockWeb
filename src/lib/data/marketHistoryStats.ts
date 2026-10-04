/**
 * 「市場歷史與情緒走勢」用的純計算函式（不發任何請求、不碰快取）——抓取在
 * marketHistory.ts，文字組裝在 lib/ai/marketHistoryText.ts（規則九：資料、抓取、
 * 文字分開；純函式獨立出來也方便用腳本直接餵假資料核對算式）。
 */

/** 交易日數換算：1週≈5、1個月≈21、3個月≈63、52週≈252 個交易日 */
export const TRADING_DAYS_1W = 5;
export const TRADING_DAYS_1M = 21;
export const TRADING_DAYS_3M = 63;
export const TRADING_DAYS_52W = 252;
/** 「近期創高／破底」看最近幾個交易日 */
export const RECENT_EXTREME_WINDOW = 5;

/**
 * VIX 情緒判斷門檻（本站自訂、非權威標準，文字會照實標「本站規則」）：
 * - 偏恐慌：VIX ≥ 25，或位於近3個月 80 百分位以上且較一週前上升 ≥ 3 點
 * - 偏樂觀：VIX < 16 且位於近3個月 30 百分位以下
 * - 其餘：中性
 * 25／16 是市場常用的經驗分界（長期中位數約 17~19），百分位用來看「相對最近」的位置。
 */
export const VIX_FEAR_LEVEL = 25;
export const VIX_CALM_LEVEL = 16;
export const VIX_FEAR_PERCENTILE = 80;
export const VIX_CALM_PERCENTILE = 30;
export const VIX_FEAR_WEEK_JUMP = 3;

export interface DailyClose {
  /** YYYY-MM-DD */
  date: string;
  close: number;
  /** 沒有就用 close 代替 */
  high?: number;
}

export interface IndexTrend {
  key: string;
  name: string;
  market: "TW" | "US";
  /** 最後一根K線日期 */
  date: string;
  close: number;
  ret1w?: number;
  ret1m?: number;
  ret3m?: number;
  /** 距52週最高價的百分比（≤0）；資料不足一年時用手上全部資料，`highWindowDays` 會標實際天數 */
  fromHigh52?: number;
  highWindowDays: number;
  aboveMa20?: boolean;
  aboveMa60?: boolean;
  /** 最近 5 個交易日內，有某天收盤創「當時往回 52 週」的最高收盤 */
  recentNewHigh52: boolean;
  /** 最近 5 個交易日內，有某天收盤跌破「當時往回 3 個月」的最低收盤 */
  recentNewLow3m: boolean;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function pct(now: number, base: number | undefined): number | undefined {
  return base != null && base > 0 ? round((now / base - 1) * 100, 2) : undefined;
}

function sma(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

/** candles 必須依日期由舊到新排序。少於 2 根回傳 null。 */
export function computeIndexTrend(
  def: { key: string; name: string; market: "TW" | "US" },
  candles: DailyClose[]
): IndexTrend | null {
  if (candles.length < 2) return null;
  const closes = candles.map((c) => c.close);
  const last = candles[candles.length - 1];
  const n = closes.length;
  const back = (days: number) => (n > days ? closes[n - 1 - days] : undefined);

  const highWindow = candles.slice(-TRADING_DAYS_52W);
  const high52 = Math.max(...highWindow.map((c) => c.high ?? c.close));
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);

  let recentNewHigh52 = false;
  let recentNewLow3m = false;
  for (let i = Math.max(1, n - RECENT_EXTREME_WINDOW); i < n; i++) {
    const priorHigh = closes.slice(Math.max(0, i - TRADING_DAYS_52W), i);
    const priorLow = closes.slice(Math.max(0, i - TRADING_DAYS_3M), i);
    // 前面的資料至少要有 3 個月才判斷，避免資料太短時每天都「創高」
    if (priorHigh.length >= TRADING_DAYS_3M && closes[i] > Math.max(...priorHigh)) recentNewHigh52 = true;
    if (priorLow.length >= TRADING_DAYS_3M && closes[i] < Math.min(...priorLow)) recentNewLow3m = true;
  }

  return {
    key: def.key,
    name: def.name,
    market: def.market,
    date: last.date,
    close: last.close,
    ret1w: pct(last.close, back(TRADING_DAYS_1W)),
    ret1m: pct(last.close, back(TRADING_DAYS_1M)),
    ret3m: pct(last.close, back(TRADING_DAYS_3M)),
    fromHigh52: high52 > 0 ? round((last.close / high52 - 1) * 100, 2) : undefined,
    highWindowDays: highWindow.length,
    aboveMa20: ma20 != null ? last.close > ma20 : undefined,
    aboveMa60: ma60 != null ? last.close > ma60 : undefined,
    recentNewHigh52,
    recentNewLow3m,
  };
}

export type VixMood = "fear" | "calm" | "neutral";

export interface VixContext {
  date: string;
  value: number;
  /** 目前值在近3個月觀測值裡的百分位（≤ 目前值的比例，0~100） */
  percentile3m: number;
  sampleSize: number;
  weekAgoValue?: number;
  monthAgoValue?: number;
  mood: VixMood;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function classifyVix(value: number, percentile: number, weekChange: number | undefined): VixMood {
  if (value >= VIX_FEAR_LEVEL) return "fear";
  if (percentile >= VIX_FEAR_PERCENTILE && weekChange != null && weekChange >= VIX_FEAR_WEEK_JUMP) return "fear";
  if (value < VIX_CALM_LEVEL && percentile <= VIX_CALM_PERCENTILE) return "calm";
  return "neutral";
}

/** obs 依日期由新到舊排序（FRED sort_order=desc 的原樣）。不足 20 筆回傳 null。 */
export function computeVixContext(obs: Array<{ date: string; value: number }>): VixContext | null {
  const latest = obs[0];
  if (!latest) return null;
  const cutoff3m = shiftDate(latest.date, -91);
  const window = obs.filter((o) => o.date > cutoff3m);
  if (window.length < 20) return null;
  const atOrBelow = window.filter((o) => o.value <= latest.value).length;
  const percentile3m = Math.round((atOrBelow / window.length) * 100);
  const weekAgo = obs.find((o) => o.date <= shiftDate(latest.date, -7));
  const monthAgo = obs.find((o) => o.date <= shiftDate(latest.date, -30));
  const weekChange = weekAgo ? latest.value - weekAgo.value : undefined;
  return {
    date: latest.date,
    value: latest.value,
    percentile3m,
    sampleSize: window.length,
    weekAgoValue: weekAgo?.value,
    monthAgoValue: monthAgo?.value,
    mood: classifyVix(latest.value, percentile3m, weekChange),
  };
}

/**
 * 連續同方向天數：series 由新到舊；正值算買超/增加、負值算賣超/減少，0 或缺值中斷。
 * 回傳正數＝連續正值天數、負數＝連續負值天數、0＝最新一天是 0 或沒資料。
 */
export function signedStreak(series: Array<number | undefined>): number {
  const first = series[0];
  if (first == null || first === 0) return 0;
  const sign = Math.sign(first);
  let count = 0;
  for (const v of series) {
    if (v == null || Math.sign(v) !== sign) break;
    count++;
  }
  return sign * count;
}
