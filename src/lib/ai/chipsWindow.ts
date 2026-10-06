/**
 * 近 N 個交易日三大法人累計（純邏輯、無 I/O）——評等籌碼面「累計版」的唯一定義（2026-10-06 評等穩定化研究）。
 *
 * 目前**正式站不使用**（stockRating 不傳 chipsWindow，籌碼面維持單日）：擴大回測（scripts/backtest/stability.ts，
 * docs/backtest/2026-10-stability.md）3／5／10 日累計都沒有比「單日＋2日確認」好（5日＋確認樣本內 10 日超額反而下降）。
 * 保留給回測比較與日後研究；要上線前必須重跑同一份回測並勝過現行。
 */
export const CHIPS_WINDOW_DAYS = 5;

export interface ChipsWindow {
  /** 實際累計了幾個交易日 */
  days: number;
  /** 累計的最後一個交易日（YYYY-MM-DD） */
  lastDate: string;
  institutionalNetShares: number;
  foreignNetShares: number;
  trustNetShares: number;
}

export interface ChipsDayRow {
  date: string;
  foreign: number;
  trust: number;
  /** 自營商（含避險） */
  dealer: number;
}

/** 取最後 n 天（舊到新的輸入）加總；不足 n 天回 null（不拿殘缺的累計冒充 n 日）。 */
export function sumChipsWindow(rows: ChipsDayRow[], n: number = CHIPS_WINDOW_DAYS): ChipsWindow | null {
  if (rows.length < n || n < 1) return null;
  const last = rows.slice(-n);
  const foreign = last.reduce((a, r) => a + r.foreign, 0);
  const trust = last.reduce((a, r) => a + r.trust, 0);
  const dealer = last.reduce((a, r) => a + r.dealer, 0);
  return {
    days: n,
    lastDate: last[last.length - 1].date,
    institutionalNetShares: foreign + trust + dealer,
    foreignNetShares: foreign,
    trustNetShares: trust,
  };
}
