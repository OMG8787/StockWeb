import { getChips } from "./companyData";
import { getForeignHolding } from "./foreignHoldings";
import { getMajorHolding } from "./majorHolders";
import { detectMarket, normalizeSymbol } from "./symbols";
import type { ChipsRatios, Market } from "./types";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * TW only — 個股頁最上方「籌碼比例」摘要的資料：融資使用率、外資持股比例、大戶
 * 持股比例，各自附上前一期（融資/外資＝前一交易日；大戶＝上一週）。
 *
 * 三項各自獨立 fail open：哪一項抓不到就只有那一項是 undefined（UI 顯示「資料
 * 暫缺」），不會拖垮其他兩項。美股沒有這些公開資料，一律回 null。
 *
 * 融資使用率＝融資餘額 ÷ 融資限額（2026-09-30 對帳：6488 前日 16,064 ÷ 119,528
 * ＝ 13.44%，跟看盤軟體一致）。前一日使用率用「前日餘額 ÷ 同一個限額」——官方報表
 * 只給當日限額，而限額是依股本計算、只在增減資時才會變，不另外為了這個多抓一份
 * 前一日報表。
 */
export async function getChipsRatios(symbolInput: string, marketHint?: Market): Promise<ChipsRatios | null> {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  if (market !== "TW") return null;

  const [chips, foreign, major] = await Promise.all([
    getChips(symbol, "TW").catch(() => null),
    getForeignHolding(symbol).catch(() => undefined),
    getMajorHolding(symbol).catch(() => undefined),
  ]);

  const result: ChipsRatios = {};
  if (chips?.marginBalance != null && chips.marginQuota != null && chips.marginQuota > 0) {
    const prevBalance = chips.marginBalanceChange != null ? chips.marginBalance - chips.marginBalanceChange : undefined;
    result.margin = {
      date: chips.marginDate,
      balance: chips.marginBalance,
      balanceChange: chips.marginBalanceChange,
      utilizationPercent: round2((chips.marginBalance / chips.marginQuota) * 100),
      prevUtilizationPercent: prevBalance != null ? round2((prevBalance / chips.marginQuota) * 100) : undefined,
    };
  }
  if (foreign) result.foreign = foreign;
  if (major) result.majorHolders = major;

  return result.margin || result.foreign || result.majorHolders ? result : null;
}
