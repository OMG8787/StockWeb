/**
 * RSI(14) 的兩種平滑算法（2026-10-07 使用者要求：「RSI 同理應改 Wilder 版」——使用者常拿券商 App 對照，KD 已改券商遞迴版）：
 *  - "wilder"（台灣券商／看盤軟體慣用，**2026-10-07 起正式站預設**）：第一個平均漲幅／跌幅＝前 14 個變動的簡單平均，之後
 *    avg＝(前avg×13＋今日變動)/14（Wilder 平滑），RSI＝100−100/(1+平均漲幅/平均跌幅)。
 *  - "simple"（舊算法，只留給回測比較）：只看最近 14 個變動的漲幅總和／跌幅總和（簡單平均，無平滑）。
 * 兩者數值差很多（例：6278 台表科 10/6 簡單 83、Wilder 73；宏璟 71 vs 63），簡單版更容易衝到 70 以上。
 * **全站 RSI 的預設只有這一個常數**（signals.computeRSI／indicators.computeRsiSeries／評等／追高防護／技術篩選／
 * 圖表／學習特徵都吃它），要改算法只改這裡；舊算法算出的快取／學習紀錄靠快取鍵版本與 RatingFeatures.rsm 隔開，不可混用。
 * Wilder 版是遞迴，初值（前 14 個變動的簡單平均）的影響隨根數衰減 (13/14)^n：評等用 63 根約剩 3%、
 * 與長歷史（242 根）的差約 0.2～0.5 點（6278：73.2 vs 73.4），圖表用暖機 K 線更小；根數很少（< 30）時只是近似。
 */
export type RsiMethod = "simple" | "wilder";

export const RSI_DEFAULT_METHOD: RsiMethod = "wilder";

/** 回測專用：fn 同步執行期間把「沒傳 method 的」RSI 計算暫時切到指定算法，結束（含例外）一律還原（同 kdFormula.withKdMethod）。 */
let activeMethod: RsiMethod = RSI_DEFAULT_METHOD;
export function withRsiMethod<T>(method: RsiMethod, fn: () => T): T {
  const prev = activeMethod;
  activeMethod = method;
  try {
    return fn();
  } finally {
    activeMethod = prev;
  }
}
export function currentRsiMethod(): RsiMethod {
  return activeMethod;
}

const toRsi = (avgGain: number, avgLoss: number): number | null => {
  if (avgGain === 0 && avgLoss === 0) return null; // 完全沒變動：不給數字（跟舊版一致）
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
};

/**
 * 逐日 RSI（與 closes 等長；前 period 個為 null——第 period 個變動要到 index=period 才有）。
 * 完全沒變動（漲跌皆 0）的日子回 null。
 */
export function rsiSeries(closes: readonly number[], period = 14, method: RsiMethod = currentRsiMethod()): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null);
  if (closes.length < period + 1) return out;
  if (method === "simple") {
    for (let i = period; i < closes.length; i++) {
      let gains = 0;
      let losses = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const change = closes[j] - closes[j - 1];
        if (change > 0) gains += change;
        else losses -= change;
      }
      out[i] = toRsi(gains, losses);
    }
    return out;
  }
  let avgGain = 0;
  let avgLoss = 0;
  for (let j = 1; j <= period; j++) {
    const change = closes[j] - closes[j - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

/** 最新一天的 RSI（根數不足或完全沒變動時 null）。 */
export function latestRsi(closes: readonly number[], period = 14, method: RsiMethod = currentRsiMethod()): number | null {
  if (closes.length < period + 1) return null;
  return rsiSeries(closes, period, method)[closes.length - 1];
}
