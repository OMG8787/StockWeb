import path from "node:path";
import { WEAK_MARKET_RET60_PCT } from "@/lib/ai/siteRating";
import { WIDE_CACHE_DIR } from "./wideConfig";

/**
 * 研究題目 C：大盤市況開關（2026-10-05 建立）。所有規則在看到任何結果「之前」寫死在這裡，不依結果調參。
 *
 * 市況定義（只用訊號日當天以前的加權指數收盤，無前視）：
 * - 定義 A（主要）：加權指數近 60 個交易日報酬 > +5% 上漲、< −5% 下跌、其餘盤整。
 *   開關＝「弱」＝ 60 日報酬 < +5%（盤整＋下跌）。
 * - 定義 B（替代）：加權指數收盤 ≥ 近 60 日均線為「強」、< MA60 為「弱」。
 * 開關規則：市況「弱」時，本站「建議買進」一律改成「等回檔」（＝不進場、持有現金），其餘不變。
 *
 * 樣本外期間（OOS）：2022-01～2024-09（含 2022 年空頭），選樣方法與擴大回測（wideConfig.ts）完全相同，
 * 只是改用 2021 年底（訊號期之前）的成交金額排名。樣本內（IS）＝擴大回測的 2024-10～2026-08 資料（直接讀既有快取）。
 */
/** 定義 A 門檻＝正式站弱市況提示門檻（siteRating.ts WEAK_MARKET_RET60_PCT，同一個常數）。 */
export const REGIME_A_PCT = WEAK_MARKET_RET60_PCT;
export const REGIME_B_MA = 60;

export interface PeriodConfig {
  key: "oos" | "is";
  label: string;
  cacheDir: string;
  selectionDates: string[];
  signalStart: string;
  signalEnd: string;
  chartFrom: string;
  chartTo: string;
}

export const OOS: PeriodConfig = {
  key: "oos",
  label: "樣本外 2022-01～2024-09",
  cacheDir: path.join(WIDE_CACHE_DIR, "regime-oos"),
  selectionDates: ["2021-12-23", "2021-12-24", "2021-12-27", "2021-12-28", "2021-12-29", "2021-12-30"],
  signalStart: "2022-01-01",
  signalEnd: "2024-09-30",
  chartFrom: "2021-07-01",
  chartTo: "2024-11-30",
};

export const IS: PeriodConfig = {
  key: "is",
  label: "樣本內 2024-10～2026-08",
  cacheDir: WIDE_CACHE_DIR,
  selectionDates: ["2024-09-23", "2024-09-24", "2024-09-25", "2024-09-26", "2024-09-27", "2024-09-30"],
  signalStart: "2024-10-01",
  signalEnd: "2026-08-31",
  chartFrom: "2024-05-01",
  chartTo: "2026-10-05",
};
