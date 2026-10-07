import type { Earnings } from "./types";

/**
 * 月營收開放資料的一列（TWSE 上市 t187ap05_L、TPEx 上櫃 mopsfin_t187ap05_O、興櫃 t187ap05_R 三個來源
 * 欄位名稱完全相同，2026-10-07 實測），統一在這裡解析成 Earnings 的月營收欄位，避免三份複製貼上。
 * 「營業收入-上月比較增減(%)」＝本月比上月的月增率；沒有（或上月營收為 0 無法比較）就不給月增率，不影響年增率。
 */
export interface MonthlyRevenueRow {
  公司代號?: string;
  資料年月?: string; // 例 "11508"＝民國 115 年 8 月
  "營業收入-上月比較增減(%)"?: string;
  "營業收入-去年同月增減(%)"?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function parseMonthlyRevenueRow(row: MonthlyRevenueRow): Earnings | null {
  const yoy = parseFloat(row["營業收入-去年同月增減(%)"] ?? "");
  if (!row.公司代號 || !Number.isFinite(yoy)) return null;
  const mom = parseFloat(row["營業收入-上月比較增減(%)"] ?? "");
  const ym = row.資料年月 ?? "";
  const period = ym.length >= 5 ? `${parseInt(ym.slice(0, -2), 10) + 1911}年${parseInt(ym.slice(-2), 10)}月` : undefined;
  return {
    monthlyRevenueYoyPercent: round2(yoy),
    ...(Number.isFinite(mom) ? { monthlyRevenueMomPercent: round2(mom) } : {}),
    monthlyRevenuePeriod: period,
  };
}

/** 營收月增率的文字（含正負號）；沒有值回 null。個股參考資料、體檢說明共用。 */
export function formatRevenueMom(e: Pick<Earnings, "monthlyRevenueMomPercent"> | null | undefined): string | null {
  const m = e?.monthlyRevenueMomPercent;
  return m == null ? null : `${m >= 0 ? "+" : ""}${m}%`;
}
