/**
 * 市況（多頭／空頭／盤整）的客觀判斷規則（純邏輯、有測試）。依據權重與相似案例都依市況分開統計，
 * 避免多頭時期學到的「追強勢股有效」套用到空頭。
 *
 * 規則（加權指數日K）：
 * - 多頭：收盤高於 MA60 超過 REGIME_BAND_PCT，且 MA60 比 REGIME_SLOPE_LOOKBACK 個交易日前高。
 * - 空頭：收盤低於 MA60 超過 REGIME_BAND_PCT，且 MA60 比 REGIME_SLOPE_LOOKBACK 個交易日前低。
 * - 其他（在 MA60 上下帶狀區內、或位置與均線方向不一致）：盤整。
 * 門檻是本站自訂，不是權威定義；改了之後舊紀錄的 rg 欄位不會重算（存的是當時判斷）。
 */

export type MarketRegime = "bull" | "bear" | "range";

export const REGIME_LABEL: Record<MarketRegime, string> = { bull: "多頭", bear: "空頭", range: "盤整" };

/** 判斷市況用的長期均線天數。 */
export const REGIME_MA_DAYS = 60;
/** 收盤距 MA60 超過這個百分比才算明確在均線上／下。 */
export const REGIME_BAND_PCT = 2;
/** MA60 的方向：跟幾個交易日前的 MA60 比。 */
export const REGIME_SLOPE_LOOKBACK = 20;

export function classifyRegime(closes: number[]): MarketRegime | null {
  const n = closes.length;
  if (n < REGIME_MA_DAYS + REGIME_SLOPE_LOOKBACK) return null;
  const ma = (end: number) => closes.slice(end - REGIME_MA_DAYS, end).reduce((a, b) => a + b, 0) / REGIME_MA_DAYS;
  const now = ma(n);
  const before = ma(n - REGIME_SLOPE_LOOKBACK);
  const dev = (closes[n - 1] / now - 1) * 100;
  if (dev > REGIME_BAND_PCT && now > before) return "bull";
  if (dev < -REGIME_BAND_PCT && now < before) return "bear";
  return "range";
}
