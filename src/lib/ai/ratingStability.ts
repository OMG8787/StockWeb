import type { HoldingCode, RatingCode } from "./siteRating";

/**
 * 評等翻轉確認（遲滯）——純邏輯、無 I/O，正式站與回測（scripts/backtest/stability.ts）共用。
 *
 * 2026-10-06 使用者回報：「有些是你昨天建議我賣我才賣，還有建議我買我才買，但今天又不一樣了」。
 * 規則：新的結論（買不買大類，或持有建議大類 續抱／減碼／出場）要「連續 2 個交易日」都算出同一個結果才換；
 * 破底（現價跌破所有均線與近期低點＝硬性風險訊號）立即生效，不等確認。
 */

export interface ConfirmState {
  /** 對外公布的結論 */
  code: RatingCode;
  holdingCode: HoldingCode;
  /** 前一次算出、但還沒確認的新結論（沒有是 null） */
  pending: { code: RatingCode; holdingCode: HoldingCode } | null;
  /** 這個狀態對應的交易日 */
  day: string;
  /** 公布的「買不買」大類已連續幾個交易日（含今天）沒變；舊狀態沒有這欄當 1。把握程度用（siteRating.ratingConfidence）。 */
  streak?: number;
}

export interface RawRating {
  code: RatingCode;
  holdingCode: HoldingCode;
  /** 硬性風險（破底）：立即生效 */
  hardRisk: boolean;
  day: string;
}

const holdClass = (h: HoldingCode) => (h === "add" || h === "hold" ? "keep" : h);
const buyClass = (c: RatingCode) => c === "buy";
const sameClass = (a: { code: RatingCode; holdingCode: HoldingCode }, b: { code: RatingCode; holdingCode: HoldingCode }) =>
  buyClass(a.code) === buyClass(b.code) && holdClass(a.holdingCode) === holdClass(b.holdingCode);

/** 以前一個交易日的狀態＋今天算出的結論，決定今天公布的結論（day 必須比 prev.day 晚一個交易日）。 */
export function applyRatingConfirmation(prev: ConfirmState | null, raw: RawRating): ConfirmState {
  const now = { code: raw.code, holdingCode: raw.holdingCode };
  const streakFor = (code: RatingCode) =>
    prev && buyClass(prev.code) === buyClass(code) ? (prev.day === raw.day ? (prev.streak ?? 1) : (prev.streak ?? 1) + 1) : 1;
  if (!prev || sameClass(prev, now) || raw.hardRisk) return { ...now, pending: null, day: raw.day, streak: streakFor(now.code) };
  if (prev.pending && sameClass(prev.pending, now)) return { ...now, pending: null, day: raw.day, streak: streakFor(now.code) };
  return { code: prev.code, holdingCode: prev.holdingCode, pending: now, day: raw.day, streak: streakFor(prev.code) };
}
