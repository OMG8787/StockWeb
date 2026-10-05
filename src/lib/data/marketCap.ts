import type { Fundamentals } from "./types";

/**
 * 市值的唯一取用入口（純函式，畫面與 AI 個股資料共用）：
 * - 美股：上游（Yahoo／Finnhub）直接給的 marketCap，原樣回傳，行為不變；
 * - 台股：現價 × 已發行普通股數（sharesOutstanding，見 twCompanyProfile.ts）。
 * 任一缺值回 undefined，畫面顯示「資料暫缺」，不估算。
 */
export function resolveMarketCap(fundamentals: Fundamentals | null | undefined, price: number | null | undefined): number | undefined {
  if (!fundamentals) return undefined;
  if (fundamentals.marketCap != null && fundamentals.marketCap > 0) return fundamentals.marketCap;
  const shares = fundamentals.sharesOutstanding;
  if (shares == null || shares <= 0 || price == null || !Number.isFinite(price) || price <= 0) return undefined;
  return price * shares;
}
