import type { Market } from "@/lib/data";
import { FINE_INDUSTRY_GROUPS } from "./fineIndustryGroups";

export type { FineIndustryGroup } from "./fineIndustryGroups";
export { FINE_INDUSTRY_GROUPS } from "./fineIndustryGroups";

/** 對不到任何細分族群時的歸類。排序時一律排在所有已分類族群之後。 */
export const OTHER_FINE_INDUSTRY = "其他";

/** 任何顯示這份細分產業分類的地方（關注清單、搜尋結果、焦點排行）都共用同一段
 *  說明，避免使用者誤以為是交易所的官方產業別，也避免多處各自維護一份文字、
 *  之後改一邊忘了改另一邊。 */
export const FINE_INDUSTRY_HINT =
  "把實際做的內容相近的股票排在一起（例如載板、矽光子/CPO、散熱、被動元件），比官方的「半導體業」「光電業」更細。此分類為本站整理、盡力而為，非官方權威分類，也沒有涵蓋全部股票——沒收錄到的股票會改顯示交易所官方的產業別（排序時排在最後）。";

interface IndexEntry {
  label: string;
  /** 在 FINE_INDUSTRY_GROUPS 裡的位置，直接當作排序時的族群先後。 */
  rank: number;
}

const INDEX: Map<string, IndexEntry> = (() => {
  const map = new Map<string, IndexEntry>();
  FINE_INDUSTRY_GROUPS.forEach((group, rank) => {
    for (const symbol of group.symbols) {
      const key = `${group.market}:${symbol.toUpperCase()}`;
      // 同一檔被不小心寫進兩組時，以先出現的那組為準（維持「一檔只屬於一組」
      // 的前提），不覆蓋、也不靜靜產生兩個不同的排序位置。
      if (!map.has(key)) map.set(key, { label: group.label, rank });
    }
  });
  return map;
})();

/** 已分類族群一律排在「其他」之前——所以「其他」的 rank 取一個必定最大的值。 */
const OTHER_RANK = Number.MAX_SAFE_INTEGER;

export interface FineIndustrySortable {
  symbol: string;
  market: Market;
  /** 交易所/資料源自己的官方產業別（例如「半導體業」「光電業」）。用來在這檔股票
   *  沒有被下面手動整理的細分族群收錄時，當一個「至少是真實分類」的退路——見
   *  fineIndustryOf() 的說明，不能沒有這個欄位就直接顯示「其他」。 */
  sector: string;
}

/**
 * 這檔股票的細分族群名稱。
 *
 * 2026-09-22 使用者反映：關注清單裡很多檔都顯示「其他」，要求要「明確標示細部是
 * 做什麼產業」。根因是這份細分表本來就刻意「只收關注清單裡實際比較可能出現的
 * 主流公司」（見 fineIndustryGroups.ts 開頭說明），逐一手動擴充到涵蓋全台股近
 * 2000檔不切實際、也永遠會有漏網之魚。真正該修的不是硬擠更多股票進手動表，
 * 而是**退路不該是一個完全沒有資訊量的「其他」**——沒被這份表收錄的股票，退回
 * 顯示它在交易所自己資料裡真實的官方產業別（`sector`，例如「半導體業」
 * 「光電業」），這永遠存在且永遠是真的，只是顆粒度比手動整理的細分類粗一些，
 * 但比「其他」有意義得多。只有連官方產業別都是空字串（資料源本身缺這欄）
 * 才會真的顯示「其他」。
 */
export function fineIndustryOf(item: FineIndustrySortable): string {
  const curated = INDEX.get(`${item.market}:${item.symbol.toUpperCase()}`)?.label;
  if (curated) return curated;
  return item.sector.trim() || OTHER_FINE_INDUSTRY;
}

function rankOf(item: FineIndustrySortable): number {
  return INDEX.get(`${item.market}:${item.symbol.toUpperCase()}`)?.rank ?? OTHER_RANK;
}

/**
 * 依細分產業排序：先把同族群的排在一起（族群先後 = FINE_INDUSTRY_GROUPS 的
 * 順序，未分類的「其他」永遠墊底），同族群內再依代號由小到大。
 *
 * 次要排序刻意用「代號」而不是漲跌幅之類的即時數字：關注清單每 20 秒重抓一次
 * 報價，用會一直變動的數字當次要鍵會讓同族群內的股票在使用者眼前跳來跳去；
 * 代號是固定的，每次排出來都一樣，使用者看習慣的相對位置不會自己跑掉。
 */
export function compareByFineIndustry(a: FineIndustrySortable, b: FineIndustrySortable): number {
  const rankDiff = rankOf(a) - rankOf(b);
  if (rankDiff !== 0) return rankDiff;
  return a.symbol.localeCompare(b.symbol, "en");
}

export function sortByFineIndustry<T extends FineIndustrySortable>(items: T[]): T[] {
  return [...items].sort(compareByFineIndustry);
}
