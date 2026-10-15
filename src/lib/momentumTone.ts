import type { Signal } from "./signals";
import { OVERHEAT_SIGNAL_PATTERNS } from "./ai/siteRating";

/**
 * 技術訊號共振股的方向（2026-10-15 全站檢查：共振榜混有「跌破均線、均線空頭排列、連跌」這種空方共振，
 * 放在推薦總覽／推薦回顧會被當成推薦）。
 * 判斷跟本站評等的「技術面」完全一樣（actionScoring.technicalFacet）：漲多警訊（RSI 超買、觸及布林上緣）不算多方理由；
 * bull＝多方訊號 ≥ 2 且沒有空方訊號（＝技術面「支持」）；bear＝空方多於多方；其餘 mixed。
 * 推薦總覽與推薦紀錄只收 bull；共振榜照列，空方的標「空方訊號」。
 */
export function momentumTone(signals: Pick<Signal, "tone" | "label">[]): "bull" | "bear" | "mixed" {
  const up = signals.filter((s) => s.tone === "up" && !OVERHEAT_SIGNAL_PATTERNS.some((p) => s.label.includes(p))).length;
  const down = signals.filter((s) => s.tone === "down").length;
  if (up >= 2 && down === 0) return "bull";
  if (down > up) return "bear";
  return "mixed";
}
