import { getChart, getChips, getChipsRatios, getEarnings, getFundamentals, getMaterialAnnouncements, getQuote } from "@/lib/data";
import type { Market } from "@/lib/data";
import { cachedWithDegradedNullTtl } from "@/lib/data/degradedCache";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import type { Facet } from "./actionScoring";
import { computeRatingCore } from "./ratingCore";
import { logRating, type RatingSource } from "./ratingLog";
import type { PriceFramework } from "./grounding/priceLevels";
import type { SiteRating } from "./siteRating";
import { ensureTwUniverseWarm, findInUniverse } from "@/lib/data/universe";
import { getTwInstitutionalMap } from "@/lib/data/companyData";
import { sectorFactorDirection } from "./grounding/sectorFactors";
import { computeRatingFeatures, type RatingFeatures } from "./learning/features";
import type { MarketRegime } from "./learning/regime";
import { getMarketRegime, getTaiexRet60Pct } from "./learning/regimeData";
import { readConfirmBase, writeConfirmState } from "./ratingConfirmStore";

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
  /** 評等當下所有判斷依據的狀態（AI 經驗累積用，見 learning/features.ts；舊快取沒有） */
  features?: RatingFeatures;
  /** 評等當下的台股市況（learning/regime.ts；抓不到加權指數時 null） */
  regime?: MarketRegime | null;
  computedAt: string;
}

/** 台股（非興櫃）缺日K或三大法人就不產生評等（純函式，有測試）；美股、興櫃本來就沒有法人資料。 */
export function isCoreInputMissing(market: Market, board: string | undefined, chart: unknown, chips: unknown): boolean {
  if (market !== "TW" || board === "emerging") return false;
  return chart == null || chips == null;
}

async function loadStockRating(symbol: string, market: Market | undefined): Promise<StockRatingResult | null> {
  const quote = await getQuote(symbol, market);
  if (!quote) return null;
  // 只用 3 個月日K（技術篩選掃描時多半已快取）：1 年日K對 TWSE 要逐月抓 12 次，名單一次評 8 檔會被限流；
  // 價位框架只用到 MA60／近60日高低，3 個月日K（約 60 根）就夠。
  // 市況＋產業外部因子方向：評等紀錄的特徵用，不影響評等結論；都 fail open。
  const regimePromise = quote.market === "TW" ? getMarketRegime().catch(() => null) : Promise.resolve(null);
  // 弱市況提示（只附提示、不改結論，見 siteRating.ts WEAK_MARKET_RET60_PCT）；美股不套。
  const marketRetPromise = quote.market === "TW" ? getTaiexRet60Pct().catch(() => null) : Promise.resolve(null);
  const sectorDirPromise = ensureTwUniverseWarm()
    .then(() =>
      sectorFactorDirection({ symbol: quote.symbol, market: quote.market, sector: findInUniverse(quote.symbol, quote.market)?.sector ?? "" })
    )
    .catch(() => null);
  // 日K／三大法人是評等的核心輸入：上游偶發失敗時重抓一次；台股（非興櫃）仍缺就回 null（只快取
  // STOCK_RATING_DEGRADED_TTL_MS），不可把「缺資料算出的評等」當正常結果快取 10 分鐘、寫評等紀錄與翻轉確認
  // （2026-10-06 四入口評測抓到：日K／法人抓不到時台表科從建議買進變成先不要買，疑為「早上買、傍晚不買」成因之一）。
  const retry = <T,>(f: () => Promise<T>) => f().catch(() => f()).catch(() => null);
  const [chart, chips, chipsRatios, fundamentals, earnings, announcements] = await Promise.all([
    retry(() => getChart(quote.symbol, "3m", quote.market)),
    retry(() => getChips(quote.symbol, quote.market)),
    getChipsRatios(quote.symbol, quote.market).catch(() => null),
    getFundamentals(quote.symbol, quote.market).catch(() => null),
    getEarnings(quote.symbol, quote.market).catch(() => null),
    getMaterialAnnouncements(quote.symbol, quote.market).catch(() => []),
  ]);
  // 法人資料 null 有兩種：全市場法人表抓失敗（要擋）vs 表正常、只是這檔當天沒有法人／融資資料（正常，照算）。
  const chipsTableOk = chips != null || (quote.market === "TW" && (await getTwInstitutionalMap().then((m) => m.size > 0).catch(() => false)));
  if (isCoreInputMissing(quote.market, quote.board, chart, chipsTableOk ? true : null)) {
    console.warn(`[stock-rating] ${quote.symbol} 核心資料缺（日K ${chart ? "有" : "無"}／法人 ${chips ? "有" : "無"}），不產生評等`);
    return null;
  }
  // 評等穩定化（2026-10-06，ratingStability.ts）：新結論需連續 2 個交易日確認（破底立即）。
  // 回測（docs/backtest/2026-10-stability.md）：籌碼面維持單日＋2日確認最好；改看 N 日累計沒有更好，所以不用。
  // 翻轉確認的「交易日」用最新一根日K的日期（週末、盤前不會被當成新的一天而提早確認）。
  const candles = chart?.candles ?? null;
  const confirmDay = candles?.length ? candles[candles.length - 1].time.slice(0, 10) : taipeiDayKey();
  const confirmPrev = await readConfirmBase(quote.symbol, confirmDay);
  // 「資料 → 結論」由 ratingCore.ts 唯一組裝（回測工具也呼叫同一個，見該檔說明）。
  const { scored, framework, chase, rating } = computeRatingCore({
    symbol: quote.symbol,
    name: quote.name,
    price: quote.price,
    changePercent: quote.changePercent,
    market: quote.market,
    board: quote.board,
    // 3 個月日K：價位框架只用到 MA60／近60日高低；追高防護也用同一份（2026-10-05 檢討回測，見 chaseGuards.ts）。
    candles: chart?.candles,
    asOfDay: taipeiDayKey(),
    chips,
    chipsRatios,
    fundamentals,
    earnings,
    announcements,
    marketRet60Pct: await marketRetPromise,
    confirmPrev,
    confirmDay,
  });
  await writeConfirmState(quote.symbol, rating.confirmState, confirmPrev);
  const [regime, sectorDirection] = await Promise.all([regimePromise, sectorDirPromise]);
  const features = computeRatingFeatures({
    candles: chart?.candles,
    price: quote.price,
    chase,
    chips,
    chipsRatios,
    earnings,
    framework,
    sectorDirection,
  });
  return {
    symbol: quote.symbol,
    market: quote.market,
    name: quote.name,
    price: quote.price,
    rating,
    facets: scored.facets,
    framework,
    features,
    regime,
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
    // v6：2026-10-07 KD 預設改券商遞迴版（kdFormula.ts），技術面的 KD 訊號與「即將交叉」門檻都變，舊快取不可沿用。
    // v5：2026-10-06 評等穩定化：翻轉需連續 2 個交易日確認（ratingStability.ts），理由多了 pendingChange。
    // v4：2026-10-05 果斷二分（不再有等回檔，偏高時附單一拉回加碼價）、弱市況提示、先不要買給改判條件。
    // v3：2026-10-05 擴大回測後：技術面不支持一票否決、急漲改為風險提示不改結論（siteRating.ts）。
    // v2：2026-10-05 加追高防護（chaseGuards.ts）、等回檔字樣改「現價不買，等回到 A～B」。
    `stock-rating:v6:${sym}:${taipeiDayKey()}`,
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
