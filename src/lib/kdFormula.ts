/**
 * KD（9,3,3）的兩種平滑算法（2026-10-07 使用者問「現在的 KD 跟券商 App 差異在哪」）：
 *  - "recursive"（台灣券商／看盤軟體慣用，**2026-10-07 起正式站預設**）：K＝2/3×前K＋1/3×RSV、D＝2/3×前D＋1/3×K，K、D 初值 50。
 *  - "sma"（舊算法，只留給回測比較）：K＝RSV 的 3 日簡單平均、D＝K 的 3 日簡單平均。
 * 換預設的依據：docs/backtest/2026-10-kd-formula.md——兩者預測力差異不顯著，但使用者常拿券商 App 對照
 * （SMA 版有 22.5% 的日子 K 與 D 的上下關係跟 App 不同），且遞迴版假交叉較少（5 日內被推翻 55% vs 75%）。
 * **全站 KD 的預設只有這一個常數**（signals.computeKd／indicators.computeKdSeries／評等／技術篩選／圖表都吃它），
 * 要改算法只改這裡；舊算法算出的快取／學習紀錄靠快取鍵版本與 RatingFeatures.kdm 隔開，不可混用。
 * 遞迴版初值 50 的影響隨根數衰減（(2/3)^(根數-9)）：評等用 63 根約 3e-10、圖表用暖機 K 線，可忽略；
 * 根數很少（< 25 根）時 K、D 會被初值拉向 50，只是近似。
 */
export type KdMethod = "sma" | "recursive";

export const KD_DEFAULT_METHOD: KdMethod = "recursive";

/** 遞迴版的初值（券商慣用 50）。 */
export const KD_RECURSIVE_SEED = 50;

/**
 * 回測專用：在 fn 同步執行期間，把「沒傳 method 的」KD 計算（computeKd／computeSignals／computeRatingCore 等）
 * 暫時切到指定算法，結束（含例外）一律還原。為什麼不把參數一路穿過 computeRatingCore：評等核心與 AI 流程
 * 簽名牽涉多個入口，只為回測加參數會擴大改動面；正式站程式碼不呼叫這個函式，預設行為不受影響。
 * fn 必須是同步函式（await 之後不保證還在覆蓋範圍內）。
 */
let activeMethod: KdMethod = KD_DEFAULT_METHOD;
export function withKdMethod<T>(method: KdMethod, fn: () => T): T {
  const prev = activeMethod;
  activeMethod = method;
  try {
    return fn();
  } finally {
    activeMethod = prev;
  }
}
export function currentKdMethod(): KdMethod {
  return activeMethod;
}

/**
 * 由「有效 RSV 序列」（第 9 根 K 線起，逐日一個值）算出 K、D 兩條序列，**兩者尾端對齊（最後一個元素＝最新交易日）**。
 * - sma：k 比 rsv 短 2、d 比 k 再短 2（跟舊實作逐值相同）。
 * - recursive：k、d 與 rsv 等長，第一天 K＝2/3×50＋1/3×RSV。
 */
export function kdFromRsv(rsv: number[], method: KdMethod): { k: number[]; d: number[] } {
  if (method === "recursive") {
    const k: number[] = [];
    const d: number[] = [];
    let pk = KD_RECURSIVE_SEED;
    let pd = KD_RECURSIVE_SEED;
    for (const r of rsv) {
      pk = (2 / 3) * pk + r / 3;
      pd = (2 / 3) * pd + pk / 3;
      k.push(pk);
      d.push(pd);
    }
    return { k, d };
  }
  const sma3 = (v: number[]) => {
    const out: number[] = [];
    for (let i = 2; i < v.length; i++) out.push((v[i - 2] + v[i - 1] + v[i]) / 3);
    return out;
  };
  const k = sma3(rsv);
  return { k, d: sma3(k) };
}
