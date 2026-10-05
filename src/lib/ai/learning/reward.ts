import type { RatingCode } from "../siteRating";

/**
 * 評等獎勵（純邏輯、無 I/O，有測試）。每筆評等滿 1／5／20 個交易日後算一次：
 *
 * - 報酬 ret：以評等當下價格為基準，到第 N 個交易日收盤。
 *   「第 1 個交易日」：開盤前的評等＝當天；盤中／盤後／收盤後的評等＝下一個交易日。
 * - 大盤 idx：加權指數同一段期間的報酬（基準＝評等前最後一個收盤；盤中評等用當天收盤近似）。
 * - 超額 ex＝ret − idx。
 * - 最大回撤 mdd：期間內最低價相對基準價跌了幾 %（沒跌是 0）。
 * - 「若買進」獎勵 brw＝ex − 交易成本 − REWARD_MDD_PENALTY × mdd（不論結論都算：依據權重用這個，
 *   代表「出現這個依據時買進划不划算」，跟結論無關，權重才不會因結論方向而反號）。
 * - 結論獎勵 rw（評這次結論對不對，成績看板用）：
 *   - 建議買進：rw＝brw。
 *   - 等回檔／先不要買（沒買）：超額 > MISS_EXCESS_THRESHOLD_PCT（說不買卻大漲）→ rw＝−ex（負）；
 *     超額 < 0（說不買後確實落後大盤）→ rw＝−ex（正）；其餘（小漲、在門檻內）→ 0。沒交易，不扣成本與回撤。
 */

/** 來回交易成本（%）：手續費 0.1425%×2（未計折扣）＋證交稅 0.3%。 */
export const TRADE_COST_PCT = 0.585;
/** 最大回撤懲罰係數：回撤 1% 扣 0.5 分。 */
export const REWARD_MDD_PENALTY = 0.5;
/** 「不買卻大漲」的超額門檻（%）。 */
export const MISS_EXCESS_THRESHOLD_PCT = 3;
/** 要算的期間（交易日）。 */
export const REWARD_HORIZONS = [1, 5, 20] as const;
export type RewardHorizon = (typeof REWARD_HORIZONS)[number];

export interface Bar {
  /** YYYY-MM-DD（可帶時間，只看前 10 碼） */
  time: string;
  low: number;
  close: number;
}

export interface HorizonOutcome {
  /** 第 N 個交易日的日期 */
  end: string;
  ret: number;
  idx: number | null;
  ex: number | null;
  mdd: number;
  brw: number | null;
  rw: number | null;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function conclusionReward(code: RatingCode, ex: number, brw: number): number {
  if (code === "buy") return brw;
  if (ex > MISS_EXCESS_THRESHOLD_PCT || ex < 0) return -ex;
  return 0;
}

/**
 * 算一筆評等在第 `horizon` 個交易日的結果；還沒滿期（日K不夠）回 null。
 * `preOpen`：評等時段是「開盤前」（當天算第 1 個交易日）。
 */
export function computeOutcome(
  rec: { code: RatingCode; price: number; day: string; preOpen: boolean },
  stock: Bar[],
  index: Bar[],
  horizon: number
): HorizonOutcome | null {
  if (!(rec.price > 0) || horizon < 1) return null;
  const after = stock.filter((b) => (rec.preOpen ? b.time.slice(0, 10) >= rec.day : b.time.slice(0, 10) > rec.day));
  if (after.length < horizon) return null;
  const end = after[horizon - 1];
  const endDay = end.time.slice(0, 10);
  const ret = (end.close / rec.price - 1) * 100;
  const minLow = Math.min(...after.slice(0, horizon).map((b) => b.low));
  const mdd = Math.max(0, (1 - minLow / rec.price) * 100);
  const baseIdx = [...index].reverse().find((b) => (rec.preOpen ? b.time.slice(0, 10) < rec.day : b.time.slice(0, 10) <= rec.day));
  const endIdx = index.find((b) => b.time.slice(0, 10) === endDay);
  const idx = baseIdx && endIdx && baseIdx.close > 0 ? (endIdx.close / baseIdx.close - 1) * 100 : null;
  const ex = idx == null ? null : ret - idx;
  const brw = ex == null ? null : ex - TRADE_COST_PCT - REWARD_MDD_PENALTY * mdd;
  const rw = ex == null || brw == null ? null : conclusionReward(rec.code, ex, brw);
  return {
    end: endDay,
    ret: r2(ret),
    idx: idx == null ? null : r2(idx),
    ex: ex == null ? null : r2(ex),
    mdd: r2(mdd),
    brw: brw == null ? null : r2(brw),
    rw: rw == null ? null : r2(rw),
  };
}
