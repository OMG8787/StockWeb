/**
 * 台股官方季報（TWSE t187ap06／TPEx／興櫃對應表）的「基本每股盈餘」是「當年度累計到該季」，
 * 不是單季：2026-10-04 對帳 2330 115年Q2 官方 49.33 ＝ 單季 Q1 22.08＋Q2 27.25。
 * 原本直接標「115年Q2」，EarningsCard、今日建議、AI 問答都會讓人當成單季 EPS 而讀錯。
 * 三個資料來源統一用這個函式產生標籤：Q1 本身就是單季，維持「115年Q1」；Q2~Q4 標
 * 「115年Q1～Q2累計」。
 */
export function twQuarterlyEpsPeriodLabel(year: string | number, season: string | number): string {
  const q = String(season).trim();
  return /^[2-4]$/.test(q) ? `${year}年Q1～Q${q}累計` : `${year}年Q${q}`;
}
