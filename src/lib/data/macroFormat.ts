import type { MacroUnit } from "./macroSeries";

/**
 * 總經數字的顯示格式——首頁卡片（MacroCard）與 AI 文字（lib/ai/macroText.ts）共用，
 * 確保兩邊講的是同一個數字、同樣的小數位數。
 */
export function formatMacroValue(value: number, unit: MacroUnit): string {
  if (unit === "percent") return `${value.toFixed(2)}%`;
  if (unit === "usdPerBarrel") return `$${value.toFixed(2)}`;
  return value.toFixed(2);
}

/** AI 文字用：帶正負號與單位的變化量；percent 類的變化量單位是「個百分點」。
 *  （首頁卡片用 ▲▼ 表方向，只顯示絕對值，不走這個函式。） */
export function formatMacroDelta(delta: number, unit: MacroUnit): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const abs = Math.abs(delta).toFixed(2);
  if (unit === "percent") return `${sign}${abs}個百分點`;
  if (unit === "usdPerBarrel") return `${sign}${abs}美元`;
  return `${sign}${abs}點`;
}

/** 浮點誤差內視為沒變（例如 3.88 − 3.88 可能算出 1e-16）。 */
export function macroDelta(value: number, prev: number | undefined): number | undefined {
  if (prev == null) return undefined;
  const d = Math.round((value - prev) * 10000) / 10000;
  return d === 0 ? 0 : d;
}
