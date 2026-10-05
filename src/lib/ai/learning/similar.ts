import { REGIME_LABEL, type MarketRegime } from "./regime";
import { similarKey, type RatingFeatures } from "./features";
import type { EvalRecord } from "./types";

/**
 * 相似案例統計（純邏輯、無 I/O，有測試）：從已算過獎勵的評等紀錄找「同市況＋同 RSI 區間＋同 5 日漲幅區間」
 * 的過去案例，給 AI 當經驗參考。每日學習工作先把紀錄彙總成小表（SimilarTable）存 Redis，
 * AI 問答只讀這張小表，不現場掃紀錄。
 */

export const SIMILAR_CASES_TITLE = "【相似案例統計（本站評等紀錄）】";
/** 樣本數低於這個值標示「樣本不足」。 */
export const SIMILAR_MIN_SAMPLES = 10;
/** 用哪個期間（交易日）。 */
export const SIMILAR_HORIZON = "5" as const;

export interface SimilarAgg {
  n: number;
  /** 5 日報酬 > 0 的筆數 */
  up: number;
  sumEx: number;
  /** 「若買進」獎勵合計 */
  sumBrw: number;
}

export type SimilarTable = Record<string, SimilarAgg>;

export function buildSimilarTable(records: EvalRecord[]): SimilarTable {
  const t: SimilarTable = {};
  for (const r of records) {
    const o = r.o[SIMILAR_HORIZON];
    if (!r.sk || !o || o.ex == null || o.brw == null) continue;
    const a = (t[r.sk] ??= { n: 0, up: 0, sumEx: 0, sumBrw: 0 });
    a.n++;
    if (o.ret > 0) a.up++;
    a.sumEx += o.ex;
    a.sumBrw += o.brw;
  }
  for (const a of Object.values(t)) {
    a.sumEx = Math.round(a.sumEx * 100) / 100;
    a.sumBrw = Math.round(a.sumBrw * 100) / 100;
  }
  return t;
}

export interface SimilarResult {
  key: string;
  n: number;
  upRatio: number | null;
  avgExcess: number | null;
  avgBuyReward: number | null;
  insufficient: boolean;
}

export function lookupSimilar(
  f: RatingFeatures | undefined,
  regime: MarketRegime | null | undefined,
  table: SimilarTable
): SimilarResult | null {
  const key = similarKey(f, regime);
  if (!key) return null;
  const a = table[key];
  const n = a?.n ?? 0;
  return {
    key,
    n,
    upRatio: n > 0 ? Math.round((a!.up / n) * 100) : null,
    avgExcess: n > 0 ? Math.round((a!.sumEx / n) * 100) / 100 : null,
    avgBuyReward: n > 0 ? Math.round((a!.sumBrw / n) * 100) / 100 : null,
    insufficient: n < SIMILAR_MIN_SAMPLES,
  };
}

const sgn = (v: number) => `${v >= 0 ? "+" : ""}${v}%`;

/** 給 AI 的一行（個股資料區塊）。比對鍵無法建立（缺 RSI／漲幅／市況）回 undefined。 */
export function describeSimilarCases(res: SimilarResult | null): string | undefined {
  if (!res) return undefined;
  const [rg, rsi, r5] = res.key.split("|");
  const cond = `同樣${REGIME_LABEL[rg as MarketRegime] ?? rg}市況、RSI ${rsi}、近5日漲幅 ${r5}%`;
  if (res.n === 0 || res.upRatio == null || res.avgExcess == null || res.avgBuyReward == null) {
    return `${SIMILAR_CASES_TITLE}條件（${cond}）：本站評等紀錄中目前 0 筆已滿 5 個交易日的相似案例——樣本不足，無法提供統計（評等紀錄 2026-10-05 才開始累積）。`;
  }
  const stats = `樣本 ${res.n} 筆，5 個交易日後上漲比例 ${res.upRatio}%、平均超額報酬（減加權指數）${sgn(res.avgExcess)}、若買進的平均獎勵（扣成本與回撤懲罰）${sgn(res.avgBuyReward)}`;
  return `${SIMILAR_CASES_TITLE}條件（${cond}）：${stats}${
    res.insufficient ? `——樣本不足（< ${SIMILAR_MIN_SAMPLES} 筆），只能當參考、不具統計意義` : ""
  }。`;
}
