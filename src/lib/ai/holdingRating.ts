import { computeHoldingStop, describeHoldingStop } from "./holdingStop";
import { applyHoldingCost, checkTakeProfit, describeSiteRating, type SiteRating } from "./siteRating";

/**
 * 「含個人成本的持股評等」唯一組裝處（純邏輯、無 I/O，有測試）。
 *
 * 2026-10-05 使用者回報：14:10 分析關注清單時把 1528、6811…判「建議減碼或出場（獲利已吐回）」，3 分鐘後問
 * 「持有名單建議盤後賣掉哪些?」卻回「沒有建議賣出的」——第二題走輕量清單（buildHoldingsGrounding），
 * 完全沒附評等也沒套成本。現在個股資料（stock.ts）、關注清單深度分析、輕量清單（要做持股決策時）都呼叫這裡，
 * 同一檔同一個成本拿到的「已持有」結論與出場價一定相同。
 */
export function describeRatingForHolding(
  rated: { name: string; symbol: string; price: number; rating: SiteRating },
  holding: { costBasis?: number | null; market: "TW" | "US"; emerging?: boolean } | null,
  candles: Array<{ high: number; low: number; close: number }> | null | undefined
): { text: string; rating: SiteRating; held: boolean } {
  const cost = holding?.costBasis != null && holding.costBasis > 0 ? holding.costBasis : null;
  if (!holding || cost == null || !candles || candles.length === 0)
    return { text: describeSiteRating(rated.name, rated.symbol, rated.rating), rating: rated.rating, held: false };
  const applied = applyHoldingCost(rated.rating, checkTakeProfit(cost, candles, rated.price));
  const stop = computeHoldingStop({ candles, price: rated.price, costBasis: cost, market: holding.market, emerging: holding.emerging });
  // 已持有：評等行不印「買進後跌破 X 出場」（那是新買進者的遠端出場價），改附持有中出場參考。
  const line = describeSiteRating(rated.name, rated.symbol, stop ? { ...applied, exit: null } : applied);
  return { text: stop ? `${line}\n${describeHoldingStop(stop, rated.price, cost)}` : line, rating: applied, held: true };
}

/** 已持有結論屬於「該賣（減碼／出場）」的評等。 */
export function isSellHoldingCode(r: SiteRating): boolean {
  return r.holdingCode === "reduce" || r.holdingCode === "exit";
}

export interface HoldingRatingEntry {
  name: string;
  symbol: string;
  text: string;
  rating: SiteRating;
  held: boolean;
}

export const HOLDING_SUMMARY_TITLE = "【持股評等彙整（含你的成本）】";

/**
 * 程式先彙整「持有中哪些該賣」：使用者問「賣掉哪些／要賣哪些」時 AI 直接照這份列，
 * 不再自己另判（避免跟深度分析的逐檔結論不同）。沒有持有中的股票回空字串。
 */
export function formatHoldingRatingSummary(entries: Array<HoldingRatingEntry | undefined>): string {
  const held = entries.filter((e): e is HoldingRatingEntry => !!e && e.held);
  if (held.length === 0) return "";
  const item = (e: HoldingRatingEntry) => `${e.name}(${e.symbol})「${e.rating.holdingLabel}」`;
  const sell = held.filter((e) => isSellHoldingCode(e.rating)).map(item);
  const keep = held.filter((e) => !isSellHoldingCode(e.rating)).map(item);
  return `${HOLDING_SUMMARY_TITLE}持有中評等為減碼／出場（該賣）的：${sell.length ? sell.join("、") : "（無）"}；其餘持有中（不用賣）：${keep.length ? keep.join("、") : "（無）"}。問「賣哪些／要不要賣／停損停利」時一律照這份與各檔評等回答，不可另外自己判斷。`;
}
