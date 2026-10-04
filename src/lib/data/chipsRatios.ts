import { mapWithConcurrency } from "./cache";
import { getTwMarginMap } from "./companyData";
import { getForeignHoldingsBatch, type ForeignHolding } from "./foreignHoldings";
import { getMajorHolding, getMajorHoldingsBatch, type MajorHolding } from "./majorHolders";
import { detectMarket, normalizeSymbol } from "./symbols";
import type { Chips, ChipsRatios, Market } from "./types";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 三份來源的單檔資料 → ChipsRatios。個股頁（getChipsRatios）與股票列表（
 * getChipsRatiosBatch）共用這一個組裝函式，確保同一檔股票兩邊看到的數字相同。
 *
 * 融資使用率＝融資餘額 ÷ 融資限額（2026-09-30 對帳：6488 前日 16,064 ÷ 119,528
 * ＝ 13.44%，跟看盤軟體一致）。前一日使用率用「前日餘額 ÷ 同一個限額」——官方報表
 * 只給當日限額，而限額是依股本計算、只在增減資時才會變，不另外為了這個多抓一份
 * 前一日報表。
 */
function assembleRatios(
  margin: Chips | undefined,
  foreign: ForeignHolding | undefined,
  major: MajorHolding | undefined
): ChipsRatios | null {
  const result: ChipsRatios = {};
  if (margin?.marginBalance != null && margin.marginQuota != null && margin.marginQuota > 0) {
    const prevBalance = margin.marginBalanceChange != null ? margin.marginBalance - margin.marginBalanceChange : undefined;
    result.margin = {
      date: margin.marginDate,
      balance: margin.marginBalance,
      balanceChange: margin.marginBalanceChange,
      utilizationPercent: round2((margin.marginBalance / margin.marginQuota) * 100),
      prevUtilizationPercent: prevBalance != null ? round2((prevBalance / margin.marginQuota) * 100) : undefined,
    };
  }
  const short = shortMarginRatio(margin);
  if (short) result.short = short;
  if (foreign) result.foreign = foreign;
  if (major) result.majorHolders = major;
  return result.margin || result.short || result.foreign || result.majorHolders ? result : null;
}

/**
 * 券資比＝融券餘額 ÷ 融資餘額 × 100。前一交易日用「前日融券餘額 ÷ 前日融資餘額」——
 * 兩個前日餘額官方報表都有（本站存成今日餘額＋增減），不用多抓一份報表。
 * 融資餘額為 0（或查不到）時沒有意義 → undefined；前日融資為 0 時前期 undefined。
 * export 給單元測試用。
 */
export function shortMarginRatio(margin: Chips | undefined): ChipsRatios["short"] {
  if (margin?.shortBalance == null || margin.marginBalance == null || margin.marginBalance <= 0) return undefined;
  const prevShort = margin.shortBalanceChange != null ? margin.shortBalance - margin.shortBalanceChange : undefined;
  const prevMargin = margin.marginBalanceChange != null ? margin.marginBalance - margin.marginBalanceChange : undefined;
  return {
    date: margin.marginDate,
    balance: margin.shortBalance,
    balanceChange: margin.shortBalanceChange,
    shortMarginRatioPercent: round2((margin.shortBalance / margin.marginBalance) * 100),
    prevShortMarginRatioPercent:
      prevShort != null && prevMargin != null && prevMargin > 0 ? round2((prevShort / prevMargin) * 100) : undefined,
  };
}

/**
 * TW only — 個股頁最上方「籌碼比例」摘要的資料：融資使用率、券資比、外資持股比例、
 * 大戶持股比例，各自附上前一期（融資/融券/外資＝前一交易日；大戶＝上一週）。
 *
 * 三項各自獨立 fail open：哪一項抓不到就只有那一項是 undefined（UI 顯示「資料
 * 暫缺」），不會拖垮其他兩項。美股沒有這些公開資料，一律回 null。
 * 大戶上一週：本站週快照沒有時，會退回查集保官網個股頁（見 majorHolders.ts）。
 */
export async function getChipsRatios(symbolInput: string, marketHint?: Market): Promise<ChipsRatios | null> {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  if (market !== "TW") return null;

  const [marginMap, foreign, major] = await Promise.all([
    getTwMarginMap().catch(() => undefined),
    getForeignHoldingsBatch([symbol]).catch(() => undefined),
    getMajorHolding(symbol).catch(() => undefined),
  ]);
  return assembleRatios(marginMap?.get(symbol), foreign?.get(symbol), major);
}

/** 批次版開放「大戶上一週退回查集保官網」的最大檔數——每檔要對集保官網送 2 個請求
 *  （實測每檔約 1~2.5 秒），只給關注清單/焦點排行這種短清單用。 */
export const MAJOR_WEB_FALLBACK_MAX_SYMBOLS = 8;
const MAJOR_WEB_FALLBACK_CONCURRENCY = 2;

/**
 * 股票列表（搜尋篩選／焦點排行／榜單／關注清單）的籌碼比例欄位：多檔一次查。
 * 三份資料都是「全市場整包快取」，這裡只在記憶體裡查表，不會對每檔各打一次上游。
 *
 * 大戶上一週預設只用本站週快照（不打集保官網）；`majorPrevFromWeb` 只在檔數
 * ≤ MAJOR_WEB_FALLBACK_MAX_SYMBOLS 時生效，對週快照沒有上一週的那幾檔改走跟個股
 * 頁相同的 getMajorHolding()（有「代號＋週別」長效快取、並行上限 2）。
 * 回傳 Map 的 key 一定涵蓋輸入的每一檔：非台股或三項都查不到的是 null。
 */
export async function getChipsRatiosBatch(
  symbols: string[],
  opts: { majorPrevFromWeb?: boolean } = {}
): Promise<Map<string, ChipsRatios | null>> {
  const twSymbols = symbols.filter((s) => detectMarket(s) === "TW");
  const twSet = new Set(twSymbols);
  const [marginMap, foreignMap, majorMap] = await Promise.all([
    getTwMarginMap().catch(() => undefined),
    getForeignHoldingsBatch(twSymbols).catch(() => undefined),
    getMajorHoldingsBatch(twSymbols).catch(() => undefined),
  ]);

  const majors = new Map(majorMap ?? []);
  if (opts.majorPrevFromWeb && twSymbols.length <= MAJOR_WEB_FALLBACK_MAX_SYMBOLS) {
    const missingPrev = twSymbols.filter((s) => majors.get(s) && majors.get(s)!.prevHoldingPercent == null);
    const filled = await mapWithConcurrency(missingPrev, MAJOR_WEB_FALLBACK_CONCURRENCY, (s) =>
      getMajorHolding(s).catch(() => undefined)
    );
    missingPrev.forEach((s, i) => {
      if (filled[i]) majors.set(s, filled[i]!);
    });
  }

  const out = new Map<string, ChipsRatios | null>();
  for (const symbol of symbols) {
    out.set(
      symbol,
      twSet.has(symbol) ? assembleRatios(marginMap?.get(symbol), foreignMap?.get(symbol), majors.get(symbol)) : null
    );
  }
  return out;
}
