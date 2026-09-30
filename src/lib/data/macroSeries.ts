/**
 * 首頁「總體經濟」卡片＋AI 大盤概況用的 FRED（美國聖路易聯準銀行）序列清單——純資料，
 * 抓取/快取邏輯在 macro.ts，文字組裝在 lib/ai/macroText.ts（規則九：資料與邏輯分離）。
 *
 * 序列代碼與頻率都是 2026-09-30 用 FRED `fred/series` 端點實際查過的（不是憑印象）：
 * - 利率刻意用日資料 DFF 而不是月資料 FEDFUNDS——FEDFUNDS 要到下個月初才出上個月的
 *   月平均，實測 9/30 最新一筆還是 8 月的 3.63%，DFF 已經是 9/28 的 3.88%，差很多。
 * - DTWEXBGS 是聯準會編的「廣義名目美元指數」（2006年1月=100），**不是**財經新聞常講的
 *   DXY 美元指數（ICE 編、1973年=100），兩者數值差很多，文字一定要講清楚是哪一個。
 * - DCOILWTICO 是日資料但 FRED 約每週才批次更新一次，最新一筆可能落後一週左右。
 *
 * 加新序列：在這裡加一筆即可，卡片與 AI 文字都會自動帶到；`key` 一旦上線就不要改
 * （快取內容用 key 對應，改了要順便把 macro.ts 的快取 key 版本號往上加）。
 */

export type MacroFrequency = "daily" | "monthly";

/** percent：數值本身就是百分比（3.88 代表 3.88%），變化量單位是「個百分點」。 */
export type MacroUnit = "percent" | "index" | "usdPerBarrel";

export interface MacroSeriesDef {
  /** 本站自己的穩定識別碼（快取與畫面對應用） */
  key: string;
  /** FRED series_id */
  seriesId: string;
  /** AI 文字用的完整中文名稱 */
  label: string;
  /** 首頁卡片用的短名稱（手機寬度也要放得下） */
  shortLabel: string;
  unit: MacroUnit;
  frequency: MacroFrequency;
  /** "yoy"：原始序列是物價指數，要自己換算成「較去年同月漲幅%」才有意義 */
  transform?: "yoy";
}

export const MACRO_SERIES: MacroSeriesDef[] = [
  { key: "fedFunds", seriesId: "DFF", label: "聯邦基金有效利率（美國央行政策利率）", shortLabel: "聯邦基金利率", unit: "percent", frequency: "daily" },
  { key: "us10y", seriesId: "DGS10", label: "美國10年期公債殖利率", shortLabel: "美10年債殖利率", unit: "percent", frequency: "daily" },
  { key: "us2y", seriesId: "DGS2", label: "美國2年期公債殖利率", shortLabel: "美2年債殖利率", unit: "percent", frequency: "daily" },
  { key: "spread10y2y", seriesId: "T10Y2Y", label: "美債10年減2年利差（負值＝殖利率倒掛）", shortLabel: "10年-2年利差", unit: "percent", frequency: "daily" },
  { key: "cpiYoy", seriesId: "CPIAUCSL", label: "美國CPI年增率（消費者物價較去年同月漲幅，即通膨率）", shortLabel: "CPI年增率", unit: "percent", frequency: "monthly", transform: "yoy" },
  { key: "unemployment", seriesId: "UNRATE", label: "美國失業率", shortLabel: "失業率", unit: "percent", frequency: "monthly" },
  { key: "dollarBroad", seriesId: "DTWEXBGS", label: "美元廣義指數（聯準會編製，2006年1月=100；不是常見的DXY美元指數，數值不能直接比較）", shortLabel: "美元廣義指數", unit: "index", frequency: "daily" },
  { key: "vix", seriesId: "VIXCLS", label: "VIX波動率指數（美股恐慌指數）", shortLabel: "VIX恐慌指數", unit: "index", frequency: "daily" },
  { key: "wti", seriesId: "DCOILWTICO", label: "WTI原油價格（美元/桶）", shortLabel: "WTI原油", unit: "usdPerBarrel", frequency: "daily" },
];
