import { computeHoldingStop, describeHoldingStop } from "./holdingStop";
import { applyHoldingCost, checkTakeProfit, confidenceRank, describeSiteRating, ratingConfidence, type SiteRating } from "./siteRating";

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
  holding: { costBasis?: number | null; /** 買進日（YYYY-MM-DD 台北）；沒有就不觸發停利規則 */ buyDate?: string | null; market: "TW" | "US"; emerging?: boolean } | null,
  candles: Array<{ high: number; low: number; close: number; time?: string }> | null | undefined
): { text: string; rating: SiteRating; held: boolean; pnlPct?: number | null } {
  const cost = holding?.costBasis != null && holding.costBasis > 0 ? holding.costBasis : null;
  if (!holding || cost == null || !candles || candles.length === 0)
    return { text: describeSiteRating(rated.name, rated.symbol, rated.rating), rating: rated.rating, held: false };
  // 現價對成本的漲跌%（未含手續費，只用來分賺賠給回答後檢查用：虧損中不可寫「獲利已吐回」）。
  const pnlPct = rated.price > 0 ? Math.round(((rated.price - cost) / cost) * 1000) / 10 : null;
  const applied = applyHoldingCost(rated.rating, checkTakeProfit(cost, candles, rated.price, holding?.buyDate));
  const stop = computeHoldingStop({ candles, price: rated.price, costBasis: cost, market: holding.market, emerging: holding.emerging });
  // 已持有：評等行不印「買進後跌破 X 出場」（那是新買進者的遠端出場價），改附持有中出場參考。
  const line = describeSiteRating(rated.name, rated.symbol, stop ? { ...applied, exit: null } : applied);
  return { text: stop ? `${line}\n${describeHoldingStop(stop, rated.price, cost)}` : line, rating: applied, held: true, pnlPct };
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
  /** 持有中：現價對成本的漲跌%（未含手續費；只用來分賺賠） */
  pnlPct?: number | null;
}

/** 彙整裡「（目前虧損約 X%）」的格式——ratingConsistencyGuard.ts 依這個判斷賺賠，兩邊共用。 */
export function holdingPnlTag(pnlPct: number | null | undefined): string {
  if (pnlPct == null || !Number.isFinite(pnlPct)) return "";
  return pnlPct < 0 ? `（目前虧損約 ${Math.abs(pnlPct)}%）` : `（目前獲利約 ${pnlPct}%）`;
}

export const HOLDING_SUMMARY_TITLE = "【持股評等彙整（含你的成本）】";

/**
 * 程式先彙整「持有中哪些該賣」：使用者問「賣掉哪些／要賣哪些」時 AI 直接照這份列，
 * 不再自己另判（避免跟深度分析的逐檔結論不同）。沒有持有中的股票回空字串。
 */
export function formatHoldingRatingSummary(entries: Array<HoldingRatingEntry | undefined>): string {
  const held = entries.filter((e): e is HoldingRatingEntry => !!e && e.held);
  if (held.length === 0) return "";
  const item = (e: HoldingRatingEntry) => `${e.name}(${e.symbol})「${e.rating.holdingLabel}」${holdingPnlTag(e.pnlPct)}`;
  const sell = held.filter((e) => isSellHoldingCode(e.rating)).map(item);
  const keep = held.filter((e) => !isSellHoldingCode(e.rating)).map(item);
  return `${HOLDING_SUMMARY_TITLE}持有中評等為減碼／出場（該賣）的：${sell.length ? sell.join("、") : "（無）"}；其餘持有中（不用賣）：${keep.length ? keep.join("、") : "（無）"}。問「賣哪些／要不要賣／停損停利」時一律照這份與各檔評等回答，不可另外自己判斷。`;
}

export const WATCH_SUMMARY_TITLE = "【僅關注評等彙整（未持有；建議買進依本站把握程度高→低）】";

/**
 * 關注清單「僅關注（未持有）」每一檔的評等彙整（關注清單深度分析用）。2026-10-06 13:25 使用者回報：逐檔分析漏掉僅關注的旺矽；
 * 同日使用者要求「建議及問答都優先顯示把握程度最高的」。回答後檢查（ratingConsistencyGuard.guardHoldingsCoverage）
 * 依這份與【持股評等彙整】確認每一檔都有寫到。沒有僅關注的回空字串。
 */
export function formatWatchRatingSummary(entries: Array<HoldingRatingEntry | undefined>): string {
  const watch = entries
    .filter((e): e is HoldingRatingEntry => !!e && !e.held)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => confidenceRank(a.e.rating) - confidenceRank(b.e.rating) || a.i - b.i)
    .map(({ e }) => e);
  if (watch.length === 0) return "";
  const item = (e: HoldingRatingEntry) => {
    const c = ratingConfidence(e.rating);
    return `${e.name}(${e.symbol})「${e.rating.label}」${c ? `（本站把握程度：${c.level}）` : ""}`;
  };
  return `${WATCH_SUMMARY_TITLE}${watch.map(item).join("、")}。每一檔都要寫到、不可漏掉。`;
}
