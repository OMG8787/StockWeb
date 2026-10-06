import type { Candle, Chips, ChipsRatios, Earnings, Fundamentals, MaterialAnnouncement } from "@/lib/data/types";
import { computeSignals, type Signal } from "@/lib/signals";
import { score, type ScoredCandidate } from "./actionScoring";
import { computeChaseMetrics, type ChaseGuardId, type ChaseMetrics } from "./chaseGuards";
import { computePriceFramework, type PriceFramework } from "./grounding/priceLevels";
import { computeSiteRating, type SiteRating } from "./siteRating";
import type { ChipsWindow } from "./chipsWindow";
import type { ConfirmState } from "./ratingStability";

/**
 * 本站綜合評等的「計算核心」（純邏輯、無 I/O，有測試）——**唯一的「資料 → 結論」組裝處**。
 *
 * 2026-10-06 整合稽核：stockRating.ts（正式站）與 scripts/backtest 的 run／wide／regime／weights 四支回測
 * 原本各自手寫「日K → 技術訊號 → 五面向評分 → 價位框架 → 追高指標 → computeSiteRating」這串組裝，
 * 共 5 份複製；任何一份改了（例如價位框架改用不同日K、興櫃規則）其他份不會跟著改，回測量到的就不是正式站的評等。
 * 現在全部呼叫這一個函式（見 docs/architecture/ai-pipeline.md「評等」一節）。
 *
 * 正式站與回測刻意保留的差異（都由呼叫端傳入，不在這裡分岔）：
 *  - 正式站 candles＝3 個月日K（含今天）；回測用「訊號日往回 63 根」近似同一個長度。
 *  - 追高指標正式站用同一份 3 個月日K；回測可另給完整歷史（chaseCandles），只影響 MA60 乖離這類長窗指標有沒有值。
 *  - 回測拿不到歷史本益比／財報／持股結構／重訊，一律傳 null（那幾個面向＝無資料）。
 */

/** 價位框架的唯一規則：興櫃成交稀疏不給（個股資料區塊、評等、備援都走這裡）。 */
export function ratingPriceFramework(
  candles: Candle[] | null | undefined,
  price: number,
  market: "TW" | "US",
  board?: string | null
): PriceFramework | null {
  if (!candles || board === "emerging") return null;
  return computePriceFramework(candles, price, market);
}

export interface RatingCoreInput {
  symbol: string;
  name: string;
  price: number;
  /** 只影響五面向說明文字，不影響判定 */
  changePercent?: number;
  market: "TW" | "US";
  board?: string | null;
  /** 3 個月日K（含今天）；null＝抓不到 */
  candles: Candle[] | null | undefined;
  /** 追高指標用的日K，預設＝candles */
  chaseCandles?: Candle[] | null;
  /** 台北日期 YYYY-MM-DD（追高指標以這天之前的日K當「之前」） */
  asOfDay: string;
  chips: Chips | null;
  /** 近 N 日三大法人累計（chipsWindow.ts）；籌碼面依這個評分，沒有就退回單日 */
  chipsWindow?: ChipsWindow | null;
  chipsRatios?: ChipsRatios | null;
  fundamentals?: Fundamentals | null;
  earnings?: Earnings | null;
  announcements?: MaterialAnnouncement[];
  /** 加權 60 日報酬（弱市況提示，不改結論）；回測不給 */
  marketRet60Pct?: number | null;
  /** 追高防護組合，預設 ACTIVE_CHASE_GUARDS（回測逐條比較時才指定） */
  guards?: readonly ChaseGuardId[];
  /**
   * 前一個交易日的翻轉確認狀態（ratingStability.ts）：有給（含 null＝沒有前一天紀錄）就套「連續 2 日確認」；
   * undefined＝不套（回測比較舊行為用）。
   */
  confirmPrev?: ConfirmState | null;
  /** 翻轉確認用的「交易日」（預設 asOfDay）；正式站用最新一根日K的日期，週末／盤前不會被當成新的一天 */
  confirmDay?: string;
}

export interface RatingCoreResult {
  signals: Signal[];
  scored: ScoredCandidate;
  framework: PriceFramework | null;
  chase: ChaseMetrics | null;
  rating: SiteRating;
}

export function computeRatingCore(input: RatingCoreInput): RatingCoreResult {
  const candles = input.candles ?? null;
  const signals = candles ? computeSignals(candles, input.price, "3m") : [];
  const scored = score({
    symbol: input.symbol,
    name: input.name,
    price: input.price,
    changePercent: input.changePercent ?? 0,
    sources: [],
    signals,
    chips: input.chips,
    chipsWindow: input.chipsWindow ?? null,
    chipsRatios: input.chipsRatios ?? null,
    fundamentals: input.fundamentals ?? null,
    earnings: input.earnings ?? null,
    announcements: input.announcements ?? [],
    headlines: [],
  });
  const framework = ratingPriceFramework(candles, input.price, input.market, input.board);
  const chaseSource = input.chaseCandles ?? candles;
  const chase = chaseSource ? computeChaseMetrics(chaseSource, input.price, input.asOfDay, input.chips?.foreignNetShares) : null;
  const rating = computeSiteRating({
    facets: scored.facets,
    supportCount: scored.supportCount,
    againstCount: scored.againstCount,
    signals,
    framework,
    chase,
    ...(input.guards ? { guards: input.guards } : {}),
    marketRet60Pct: input.marketRet60Pct,
    ...(input.confirmPrev !== undefined ? { confirm: { prev: input.confirmPrev, day: input.confirmDay ?? input.asOfDay } } : {}),
  });
  return { signals, scored, framework, chase, rating };
}
