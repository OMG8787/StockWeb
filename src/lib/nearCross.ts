/**
 * 「即將黃金交叉／死亡交叉」的判斷（2026-10-05 新增）。
 *
 * 起因：使用者在 AI 問答問「那有快黃金交叉的嗎?」，AI 只能回答系統沒有這份清單，
 * 使用者回報要補上這個功能。這裡只用「已經抓好的 K 線算出來的指標序列」判斷，
 * 不額外打任何上游請求。
 *
 * **重要：以下所有門檻都是本站自訂的經驗值，不是任何權威／教科書標準。**
 * 「快要交叉」本質上是拿最近幾天的收斂趨勢往後線性外推，明天價格一變就可能
 * 不交叉（甚至反向拉開），所以呼叫端（AI 文字）必須寫明「只是推估」。
 *
 * 判斷邏輯（快線＝K 值或 MACD 的 DIF，慢線＝D 值或訊號線）：
 * 1. 觀察視窗＝最近 `convergingDays + 1` 天，這段期間快線一直在慢線同一側
 *    （黃金交叉候選：快線 < 慢線；死亡交叉候選：快線 > 慢線）——視窗裡已經
 *    交叉過的，屬於「已交叉」而不是「即將交叉」。
 * 2. 兩線差距（|慢線 − 快線|；MACD 就是柱狀體 DIF−訊號線 的絕對值）在視窗內
 *    **逐日嚴格縮小**，連續 `convergingDays` 天。
 * 3. 依最後一天的縮小速度線性外推，約 `estDays` 個交易日差距歸零；要 ≤ 門檻。
 * 4. 選用：差距本身 ≤ `maxGap`（KD 用，KD 是 0~100 的固定刻度；MACD 的刻度隨
 *    股價高低差很多，不適合用固定點數，只靠第 3 點的相對速度判斷）。
 * 5. 選用：快線本身朝交叉方向移動（黃金交叉候選 K 值今天上升、死亡交叉候選
 *    K 值今天下降），排除「快線沒動、只是慢線自己靠過來」的情況。
 */

export interface NearCrossReading {
  /** 即將發生的交叉方向。 */
  direction: "golden" | "death";
  /** 最新交易日的快線值（K 值或 DIF）。 */
  fast: number;
  /** 最新交易日的慢線值（D 值或 MACD 訊號線）。 */
  slow: number;
  /** 觀察視窗內每天的兩線差距（絕對值，舊→新；最後一個＝最新交易日）。 */
  gaps: number[];
  /** 依最新一天的收斂速度線性外推，約幾個交易日差距歸零（推估值，不保證）。 */
  estDays: number;
}

// ---- KD（9,3,3）的「即將交叉」門檻：本站自訂經驗值，不是權威標準 ----
// 2026-10-07：KD 預設改為券商遞迴版（kdFormula.ts）後，用回測重新校準（scripts/backtest/kdNearCross.ts，
// docs/backtest/2026-10-kd-formula.md）。校準規則：命中＝訊號後 3 個交易日內 K 真的往預測方向穿越 D；
// 在樣本內挑「命中率不低於舊 SMA 版現行品質（81.1%）、且訊號頻率最接近舊版」的組合，樣本外確認。
// 舊 SMA 版門檻為 gap 5／收斂 2 天／外推 3 天。
/** D 值與 K 值差距在幾點以內才算「很接近」（KD 為 0~100 刻度）。（遞迴版 K、D 差距較小，由 5 收緊為 4） */
export const KD_NEAR_CROSS_MAX_GAP = 4;
/** 差距要連續縮小幾天。 */
export const KD_NEAR_CROSS_CONVERGING_DAYS = 2;
/** 照目前速度外推，最多幾個交易日內會交叉。（由 3 收緊為 2） */
export const KD_NEAR_CROSS_MAX_EST_DAYS = 2;

// ---- MACD（12,26,9）的「即將交叉」門檻：本站自訂經驗值，不是權威標準 ----
// 2026-10-07：用回測校準（scripts/backtest/macdNearCross.ts，docs/backtest/2026-10-macd-near-cross.md），方法同 KD：
// 命中＝訊號後 3 個交易日內 DIF 真的往預測方向穿越訊號線；規則看結果前寫死——樣本內命中率不低於舊門檻（收斂 3 天／外推 2 天，
// 72.2%）者中取訊號頻率最高，再用樣本外確認。結果：收斂 1 天／外推 1.5 天，命中 75.2%（舊 72.2%）、每檔每月 2.33 次（舊 1.74），
// 樣本外 75.4%（舊 72.4%），命中率與頻率都比舊門檻好。
/** 柱狀體（DIF−訊號線）絕對值要連續縮小幾天。 */
export const MACD_NEAR_CROSS_CONVERGING_DAYS = 1;
/** 照目前柱狀體縮小速度外推，最多幾個交易日內歸零（＝柱狀體已經很接近 0）。 */
export const MACD_NEAR_CROSS_MAX_EST_DAYS = 1.5;

export interface NearCrossOptions {
  convergingDays: number;
  maxEstDays: number;
  maxGap?: number;
  /** 要求快線本身朝交叉方向移動（見檔頭第 5 點）。 */
  requireFastMoving?: boolean;
}

/**
 * 依快線／慢線序列判斷是否「即將交叉」。兩個序列以「最後一個元素＝最新交易日」
 * 對齊（長度可以不同，例如 KD 的 D 序列比 K 序列短）；視窗內有 null 或根數不足
 * 一律回 null，不硬算。
 */
export function detectNearCross(
  fast: readonly (number | null)[],
  slow: readonly (number | null)[],
  opts: NearCrossOptions
): NearCrossReading | null {
  const n = opts.convergingDays + 1;
  if (fast.length < n || slow.length < n) return null;
  const f = fast.slice(-n);
  const s = slow.slice(-n);
  if (f.some((v) => v == null) || s.some((v) => v == null)) return null;
  const fv = f as number[];
  const sv = s as number[];

  const diffs = fv.map((v, i) => v - sv[i]);
  const today = diffs[n - 1];
  if (today === 0) return null;
  const direction: "golden" | "death" = today < 0 ? "golden" : "death";
  // 視窗內必須一直在同一側（已經交叉過的不算「即將」）。
  if (diffs.some((d) => (direction === "golden" ? d >= 0 : d <= 0))) return null;

  const gaps = diffs.map((d) => Math.abs(d));
  for (let i = 1; i < n; i++) if (!(gaps[i] < gaps[i - 1])) return null;

  const gapToday = gaps[n - 1];
  if (opts.maxGap != null && gapToday > opts.maxGap) return null;

  const shrink = gaps[n - 2] - gapToday;
  const estDays = gapToday / shrink;
  if (estDays > opts.maxEstDays) return null;

  if (opts.requireFastMoving) {
    const fastDelta = fv[n - 1] - fv[n - 2];
    if (direction === "golden" ? fastDelta <= 0 : fastDelta >= 0) return null;
  }

  return { direction, fast: fv[n - 1], slow: sv[n - 1], gaps, estDays };
}
