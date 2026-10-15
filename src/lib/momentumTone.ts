import type { Signal } from "./signals";

/**
 * 技術訊號共振股的方向（2026-10-15 全站檢查：共振榜混有「跌破均線、均線空頭排列、連跌」這種空方共振，
 * 放在推薦總覽／推薦回顧會被當成推薦）。bull＝多方訊號 ≥ 2 且沒有空方訊號；bear＝空方多於多方；其餘 mixed。
 * 推薦總覽與推薦回顧只收 bull；共振榜照列但空方的標「空方訊號」。
 */
export function momentumTone(signals: Pick<Signal, "tone">[]): "bull" | "bear" | "mixed" {
  const up = signals.filter((s) => s.tone === "up").length;
  const down = signals.filter((s) => s.tone === "down").length;
  if (up >= 2 && down === 0) return "bull";
  if (down > up) return "bear";
  return "mixed";
}
