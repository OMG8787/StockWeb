import type { Candle } from "@/lib/data/types";

// Full-series versions of the same indicators lib/signals.ts already
// computes for the text signal tags (same formulas, same parameters — kept
// as a separate module rather than exported from signals.ts because that
// file only ever needed the LATEST value/cross, not a value per candle to
// draw as a chart line). Every series is aligned to the input candles by
// `time` string, with no entry for a candle that doesn't yet have enough
// trailing history — callers should not assume one point per input candle.

export interface IndicatorPoint {
  time: string;
  value: number;
}

function sma(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }
    const slice = values.slice(i - period + 1, i + 1);
    result.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return result;
}

/**
 * 指數移動平均——**必須跟 lib/signals.ts 的 `ema()` 完全同一套算法**，
 * 否則圖上的 MACD 副圖會跟技術訊號標籤講不同的話。種子用前 `period` 根的
 * 簡單移動平均（教科書標準做法），前 `period − 1` 根回 `null`；輸入開頭
 * 帶 `null`（MACD 訊號線的情形）也支援。詳細理由見 signals.ts 的註解。
 */
function ema(values: (number | null)[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const result: (number | null)[] = new Array(values.length).fill(null);
  let start = 0;
  while (start < values.length && values[start] == null) start++;
  if (values.length - start < period) return result;
  let sum = 0;
  for (let i = start; i < start + period; i++) sum += values[i] as number;
  let prev = sum / period;
  result[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    const v = values[i];
    if (v == null) break;
    prev = v * k + prev * (1 - k);
    result[i] = prev;
  }
  return result;
}

export function computeMaSeries(candles: Candle[], period: number): IndicatorPoint[] {
  const closes = candles.map((c) => c.close);
  const values = sma(closes, period);
  const points: IndicatorPoint[] = [];
  for (let i = 0; i < candles.length; i++) {
    const v = values[i];
    if (v != null) points.push({ time: candles[i].time, value: v });
  }
  return points;
}

export interface BollingerSeries {
  upper: IndicatorPoint[];
  middle: IndicatorPoint[];
  lower: IndicatorPoint[];
}

/** 20-period SMA ± `mult` standard deviations of that same window — same
 *  parameters as lib/signals.ts's computeBollingerSignal. */
export function computeBollingerSeries(candles: Candle[], period = 20, mult = 2): BollingerSeries {
  const upper: IndicatorPoint[] = [];
  const middle: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];
  const closes = candles.map((c) => c.close);
  for (let i = period - 1; i < candles.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, c) => a + (c - mean) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);
    const time = candles[i].time;
    middle.push({ time, value: mean });
    upper.push({ time, value: mean + mult * stdDev });
    lower.push({ time, value: mean - mult * stdDev });
  }
  return { upper, middle, lower };
}

/** Simple (non-Wilder-smoothed) RSI, one value per candle once `period`
 *  trailing closes are available — same method as lib/signals.ts's
 *  computeRSI, just returning every day's value instead of only the last. */
export function computeRsiSeries(candles: Candle[], period = 14): IndicatorPoint[] {
  const points: IndicatorPoint[] = [];
  for (let i = period; i < candles.length; i++) {
    let gains = 0;
    let losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const change = candles[j].close - candles[j - 1].close;
      if (change > 0) gains += change;
      else losses -= change;
    }
    if (gains === 0 && losses === 0) continue;
    const value = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
    points.push({ time: candles[i].time, value });
  }
  return points;
}

export interface MacdSeries {
  macd: IndicatorPoint[];
  signal: IndicatorPoint[];
  histogram: IndicatorPoint[];
}

/** EMA12 − EMA26, its EMA9 signal line, and their difference as a histogram
 *  — same parameters as lib/signals.ts's computeMacdCross. EMA 用 SMA 種子
 *  之後，訊號線最早要到第 34 根才有有效值；這裡仍沿用 signals.ts 的
 *  MIN_BARS 門檻當作「資料夠不夠」的判斷，並且只畫真的有值的點。 */
export function computeMacdSeries(candles: Candle[]): MacdSeries {
  const MIN_BARS = 50;
  if (candles.length < MIN_BARS) return { macd: [], signal: [], histogram: [] };
  const closes = candles.map((c) => c.close);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => {
    const fast = ema12[i];
    const slow = ema26[i];
    return fast == null || slow == null ? null : fast - slow;
  });
  const signalLine = ema(macdLine, 9);
  const macd: IndicatorPoint[] = [];
  const signal: IndicatorPoint[] = [];
  const histogram: IndicatorPoint[] = [];
  // 維持原本從 MIN_BARS 之後才開始畫的行為（跟 signals.ts 判讀交叉的
  // 資料範圍一致），並額外跳過沒有有效值的點。
  for (let i = MIN_BARS - 1; i < candles.length; i++) {
    const m = macdLine[i];
    const s = signalLine[i];
    if (m == null || s == null) continue;
    const time = candles[i].time;
    macd.push({ time, value: m });
    signal.push({ time, value: s });
    histogram.push({ time, value: m - s });
  }
  return { macd, signal, histogram };
}

export interface KdSeries {
  k: IndicatorPoint[];
  d: IndicatorPoint[];
}

/** (9,3,3) stochastic oscillator — same method/parameters as
 *  lib/signals.ts's computeKdCross, returning the full %K/%D series instead
 *  of only the latest cross. */
export function computeKdSeries(candles: Candle[]): KdSeries {
  const PERIOD = 9;
  const SMOOTH = 3;
  if (candles.length < PERIOD + SMOOTH * 2) return { k: [], d: [] };

  const rawK: (number | null)[] = candles.map((c, i) => {
    if (i < PERIOD - 1) return null;
    const window = candles.slice(i - PERIOD + 1, i + 1);
    const highestHigh = Math.max(...window.map((w) => w.high));
    const lowestLow = Math.min(...window.map((w) => w.low));
    const range = highestHigh - lowestLow;
    return range > 0 ? ((c.close - lowestLow) / range) * 100 : 50;
  });
  const firstValidIndex = rawK.findIndex((v) => v !== null);
  if (firstValidIndex === -1) return { k: [], d: [] };
  const validRawK = rawK.slice(firstValidIndex) as number[];
  const kValues = sma(validRawK, SMOOTH);
  const kValuesCompact = kValues.filter((v): v is number => v !== null);
  const dValues = sma(kValuesCompact, SMOOTH);

  // kValuesCompact[j] corresponds to candle index firstValidIndex + SMOOTH-1 + j
  // (sma() drops the first SMOOTH-1 entries of validRawK as nulls before the
  // window is full); dValues is derived the same way one level further in.
  const k: IndicatorPoint[] = [];
  const d: IndicatorPoint[] = [];
  const kOffset = firstValidIndex + (SMOOTH - 1);
  for (let j = 0; j < kValuesCompact.length; j++) {
    const candleIndex = kOffset + j;
    if (candleIndex >= candles.length) break;
    k.push({ time: candles[candleIndex].time, value: kValuesCompact[j] });
  }
  // dValues is sma(kValuesCompact, SMOOTH) — indexed 1:1 with kValuesCompact
  // (not further compacted), so dValues[j] maps to the SAME candle index as
  // kValuesCompact[j], i.e. kOffset + j (not kOffset + (SMOOTH-1) + j — an
  // earlier version double-counted the smoothing offset here and shifted
  // every D point 2 candles later than it should be, caught by comparing
  // against a brute-force reference computed independently at every index).
  for (let j = 0; j < dValues.length; j++) {
    const v = dValues[j];
    const candleIndex = kOffset + j;
    if (v == null || candleIndex >= candles.length) continue;
    d.push({ time: candles[candleIndex].time, value: v });
  }
  return { k, d };
}
