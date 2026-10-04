/**
 * 全站唯一一份 EMA／MACD 計算。原本 lib/signals.ts（技術訊號標籤、AI 多重指標篩選）與
 * lib/indicators.ts（圖表 MACD 副圖）各有一份 `ema()`，靠註解約定「必須完全相同」；
 * 2026-10-04 逐行比對確認兩份（去掉註解後）完全一致，合併到這裡，兩邊 import，之後不可能
 * 再各改各的而讓圖上的 MACD 跟技術訊號標籤講不同的話。
 */

/**
 * 指數移動平均，採教科書標準的種子做法：第一個有效值＝**前 `period` 根的
 * 簡單移動平均（SMA）**，從第 `period + 1` 根起才套遞迴公式
 * `EMA = 收盤 × k + 前一日EMA × (1 − k)`。
 *
 * 舊版是拿 `values[0]`（單一個值）直接當種子，那是另一種業界也有人用的
 * 簡化寫法，但在本站 K 線通常只有 63 根（3 個月）的情況下，EMA26 的暖機
 * 偏差還沒完全衰減掉，會讓**臨界的 MACD 交叉**在「今天交叉」與「昨天就
 * 交叉了」之間翻面（實測 KLAC、聯詠 3034 都落在這個臨界區）。改用 SMA
 * 種子後跟主流看盤軟體一致。
 *
 * 前 `period − 1` 個點沒有足夠歷史、算不出有效值，照本檔「算不出來就不要
 * 編數字」的慣例回 `null`（不是硬塞一個暖機中的近似值）。輸入序列開頭本身
 * 就帶 `null` 也支援（MACD 訊號線就是這種情況：MACD 線前 25 根是 null），
 * 會從第一個有值的位置開始算種子。
 */
export function ema(values: (number | null)[], period: number): (number | null)[] {
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
    if (v == null) break; // 有值的區段中斷就停住，不跨過缺口硬接
    prev = v * k + prev * (1 - k);
    result[i] = prev;
  }
  return result;
}

/** MACD 判讀／繪圖所需的最少 K 線根數：本站 "3m" 圖約 60~65 個交易日，留點餘裕給短月份。 */
export const MACD_MIN_BARS = 50;

/**
 * MACD 線（DIF＝EMA12 − EMA26）與其 EMA9 訊號線，兩條都與 closes 等長，
 * 沒有足夠歷史的位置為 null（SMA 種子下 MACD 線前 25 根、訊號線前 33 根）。
 */
export function computeMacdLines(closes: number[]): { macdLine: (number | null)[]; signalLine: (number | null)[] } {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => {
    const fast = ema12[i];
    const slow = ema26[i];
    return fast == null || slow == null ? null : fast - slow;
  });
  const signalLine = ema(macdLine, 9);
  return { macdLine, signalLine };
}
