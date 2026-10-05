import { getChart, getChips, getChipsRatios, getEarnings, getFundamentals, getMaterialAnnouncements, getQuote } from "@/lib/data";
import type { Market } from "@/lib/data";
import { cachedWithDegradedNullTtl } from "@/lib/data/degradedCache";
import { computeSignals } from "@/lib/signals";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { score, type Facet } from "./actionScoring";
import { computeChaseMetrics } from "./chaseGuards";
import { logRating, type RatingSource } from "./ratingLog";
import { computePriceFramework, type PriceFramework } from "./grounding/priceLevels";
import { computeSiteRating, type SiteRating } from "./siteRating";

/**
 * 單一個股的「本站綜合評等」唯一入口（有 I/O、有快取）。今日建議、AI 問答全市場推薦、
 * 個股問答（含「問AI關於」）三個入口都只透過這個函式取得結論，同一檔股票在同一個
 * 10 分鐘快取期間內三邊拿到的是同一份資料、同一個結論（見 siteRating.ts 說明）。
 *
 * 價位框架也一起存在這份快取裡：個股資料區塊的【價位參考】直接用這份，買進區間的數字
 * 才會跟評等裡的區間逐字相同。
 */

/** 跟今日建議同樣 10 分鐘（ACTION_BRIEF_TTL_MS）。 */
export const STOCK_RATING_TTL_MS = 10 * 60_000;
/** 抓不到資料（null）只快取 60 秒，不讓一次上游失敗卡住 10 分鐘。 */
const STOCK_RATING_DEGRADED_TTL_MS = 60_000;

export interface StockRatingResult {
  symbol: string;
  market: Market;
  name: string;
  price: number;
  rating: SiteRating;
  /** 五面向評分（評等紀錄用） */
  facets: Facet[];
  framework: PriceFramework | null;
  computedAt: string;
}

async function loadStockRating(symbol: string, market: Market | undefined): Promise<StockRatingResult | null> {
  const quote = await getQuote(symbol, market);
  if (!quote) return null;
  // 只用 3 個月日K（技術篩選掃描時多半已快取）：1 年日K對 TWSE 要逐月抓 12 次，名單一次評 8 檔會被限流；
  // 價位框架只用到 MA60／近60日高低，3 個月日K（約 60 根）就夠。
  const [chart, chips, chipsRatios, fundamentals, earnings, announcements] = await Promise.all([
    getChart(quote.symbol, "3m", quote.market).catch(() => null),
    getChips(quote.symbol, quote.market).catch(() => null),
    getChipsRatios(quote.symbol, quote.market).catch(() => null),
    getFundamentals(quote.symbol, quote.market).catch(() => null),
    getEarnings(quote.symbol, quote.market).catch(() => null),
    getMaterialAnnouncements(quote.symbol, quote.market).catch(() => []),
  ]);
  const signals = chart ? computeSignals(chart.candles, quote.price, "3m") : [];
  const scored = score({
    symbol: quote.symbol,
    name: quote.name,
    price: quote.price,
    changePercent: quote.changePercent,
    sources: [],
    signals,
    chips,
    chipsRatios,
    fundamentals,
    earnings,
    announcements,
    headlines: [],
  });
  // 興櫃成交稀疏不給價位框架（跟個股資料區塊同一個規則）。
  const levelCandles = chart?.candles;
  const framework =
    levelCandles && quote.board !== "emerging" ? computePriceFramework(levelCandles, quote.price, quote.market) : null;
  // 追高防護（2026-10-05 檢討回測，見 chaseGuards.ts）：用同一份 3 個月日K＋現價＋當日外資買賣超。
  const chase = chart ? computeChaseMetrics(chart.candles, quote.price, taipeiDayKey(), chips?.foreignNetShares) : null;
  const rating = computeSiteRating({
    facets: scored.facets,
    supportCount: scored.supportCount,
    againstCount: scored.againstCount,
    signals,
    framework,
    chase,
  });
  return {
    symbol: quote.symbol,
    market: quote.market,
    name: quote.name,
    price: quote.price,
    rating,
    facets: scored.facets,
    framework,
    computedAt: new Date().toISOString(),
  };
}

/**
 * `source`：從哪個入口來（評等紀錄用，見 ratingLog.ts）；有給就在回應送出後記一筆
 * （同一檔同一天同一結論只記第一次，fail open、不拖慢回應）。
 */
export async function getStockRating(symbol: string, market?: Market, source?: RatingSource): Promise<StockRatingResult | null> {
  const result = await getStockRatingCached(symbol, market);
  if (result && source) logRating(result, source);
  return result;
}

function getStockRatingCached(symbol: string, market?: Market): Promise<StockRatingResult | null> {
  const sym = symbol.trim().toUpperCase();
  // key 刻意不含 market：同一檔從不同入口進來時有的知道市場、有的不知道（問AI關於只帶代號），
  // key 不同就會各算各的、結論可能不一致；台股代號是數字、美股是英文，不會撞。帶台北日期：跨日不沿用。
  return cachedWithDegradedNullTtl<StockRatingResult>(
    // v2：2026-10-05 加追高防護（chaseGuards.ts）、等回檔字樣改「現價不買，等回到 A～B」。
    `stock-rating:v2:${sym}:${taipeiDayKey()}`,
    STOCK_RATING_TTL_MS,
    STOCK_RATING_DEGRADED_TTL_MS,
    () => loadStockRating(sym, market)
  );
}

/** 一批股票的評等，限制併發（每檔可能要抓日K，避免對 TWSE 一次打太多）。 */
export async function getStockRatings(
  targets: Array<{ symbol: string; market?: Market }>,
  concurrency = 2,
  source?: RatingSource
): Promise<Map<string, StockRatingResult>> {
  const out = new Map<string, StockRatingResult>();
  let i = 0;
  const worker = async () => {
    while (i < targets.length) {
      const t = targets[i++];
      const r = await getStockRating(t.symbol, t.market, source).catch(() => null);
      if (r) out.set(t.symbol.toUpperCase(), r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return out;
}
