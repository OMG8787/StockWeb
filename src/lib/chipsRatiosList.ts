import type { ChipsRatios } from "./data/types";

/**
 * 股票列表「籌碼比例」四欄（大戶持股／外資持股／融資使用率／融券使用率）前後端共用的精簡格式。
 * 批次 API（/api/chips-ratios?symbols=...）一次回幾十檔，只送列表真的會顯示的
 * 數字，不送個股頁那些明細（餘額張數、人數…），前端 hook 也只認這個形狀。
 * 這個檔案只放型別與純函式，client/server 都能 import。
 */

/** [本期%, 前一期%（沒有＝null）]——融資/外資的前一期是前一交易日，大戶是上一週。 */
export type RatioPair = [number, number | null];

export interface ListChipsRatios {
  margin?: RatioPair;
  foreign?: RatioPair;
  major?: RatioPair;
  /** 融券使用率（融券餘額 ÷ 融券限額）[本期, 前一交易日] */
  short?: RatioPair;
}

/** 列表／排序可挑的四項，順序＝畫面由左到右（大戶→外資→融資→融券）。 */
export type ChipsRatioPick = "major" | "foreign" | "margin" | "short";
export const CHIPS_RATIO_PICKS: readonly ChipsRatioPick[] = ["major", "foreign", "margin", "short"];

export interface ChipsRatiosBatchResponse {
  /** key＝台股代號；null＝四項都查不到（例如興櫃、ETF 等沒有這些資料的代號）。 */
  items: Record<string, ListChipsRatios | null>;
  /** 大戶週資料的本週／上一週日期（YYYY-MM-DD），給欄位提示文字用。 */
  majorDate?: string;
  majorPrevDate?: string;
}

/** 單次批次請求最多幾檔——列表是依「畫面上看得到的列」漸進要資料，正常一次只有幾十檔。 */
export const CHIPS_BATCH_MAX_SYMBOLS = 100;

/** 只收台股代號（4 碼數字，ETF/特別股可能再多 1~2 碼英數，例如 00878、00632R、2881A）。 */
export const TW_SYMBOL_PATTERN = /^\d{4}[0-9A-Z]{0,2}$/;

export function toListRatios(r: ChipsRatios | null): ListChipsRatios | null {
  if (!r) return null;
  const out: ListChipsRatios = {};
  if (r.margin) out.margin = [r.margin.utilizationPercent, r.margin.prevUtilizationPercent ?? null];
  if (r.foreign) out.foreign = [r.foreign.holdingPercent, r.foreign.prevHoldingPercent ?? null];
  if (r.majorHolders) out.major = [r.majorHolders.holdingPercent, r.majorHolders.prevHoldingPercent ?? null];
  if (r.short) out.short = [r.short.utilizationPercent, r.short.prevUtilizationPercent ?? null];
  return out;
}

/** 某一項的本期比例（/search 排序用）；沒有這項回 null（排序時墊底，不當成 0）。 */
export function ratioValue(r: ChipsRatios | null | undefined, pick: ChipsRatioPick): number | null {
  return toListRatios(r ?? null)?.[pick]?.[0] ?? null;
}
