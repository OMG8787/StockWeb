import { REGIME_LABEL, type MarketRegime } from "./regime";
import type { EvalRecord } from "./types";

/**
 * 判斷依據權重（獎勵機制核心；純邏輯、無 I/O，有測試）。
 *
 * 每個「判斷依據鍵（features.ts featureBases）× 市況」維護累積統計，權重＝收縮後的平均「若買進」獎勵（%）：
 *   weight = Σ(dᵢ·brwᵢ) / (Σdᵢ + WEIGHT_PRIOR_STRENGTH)
 * 6 項保險的對應：
 *  ① 最少樣本：筆數 < WEIGHT_MIN_SAMPLES 時 active＝false（權重視為 0＝中性，只展示不使用）。
 *  ② 貝氏收縮：分母加 WEIGHT_PRIOR_STRENGTH 筆「獎勵 0」的虛擬樣本，樣本少時自然趨近 0（中性）。
 *  ③ 指數衰減：dᵢ＝0.5^(距今交易日數 / WEIGHT_HALF_LIFE_TRADING_DAYS)，近期權重高。
 *  ④ 市況分開：多頭／空頭／盤整各自一組統計（市況未知的舊紀錄不進權重）。
 *  ⑤ 上線前回測：LEARNED_WEIGHTS_ENABLED 預設 false；要打開前必須先跑
 *     `npx tsx scripts/backtest/weights.ts`（前段學、後段驗證）且後段通過。
 *  ⑥ 公開：成績看板 /scoreboard 列出每個依據的筆數、平均獎勵、勝率、權重。
 */

/** 權重用哪個期間的獎勵（交易日）。 */
export const WEIGHT_HORIZON = "5" as const;
/** 至少幾筆才讓權重偏離中性。 */
export const WEIGHT_MIN_SAMPLES = 30;
/** 貝氏收縮的先驗強度（等同幾筆獎勵 0 的虛擬樣本）。 */
export const WEIGHT_PRIOR_STRENGTH = 30;
/** 指數衰減半衰期（交易日）。 */
export const WEIGHT_HALF_LIFE_TRADING_DAYS = 60;
/** 日曆天換算交易日的近似比例（一週 5 個交易日；不扣國定假日）。 */
export const TRADING_DAYS_PER_CALENDAR_DAY = 5 / 7;
/** 所有啟用權重加總後，對評分的調整上限（±%）。 */
export const WEIGHT_MAX_TOTAL_ADJUST = 3;
/**
 * Feature flag：學到的權重是否真的影響評等。第一階段一律 false（只計算與展示）。
 * 打開前必須：①各依據樣本達門檻、②scripts/backtest/weights.ts 用未用過的後段資料驗證通過。
 */
export const LEARNED_WEIGHTS_ENABLED = false;

export interface BasisStat {
  basis: string;
  regime: MarketRegime;
  /** 實際筆數 */
  n: number;
  /** 衰減後的有效樣本數 */
  neff: number;
  /** 衰減加權的平均「若買進」獎勵（%） */
  avgBuyReward: number;
  /** 平均結論獎勵（%，未衰減） */
  avgReward: number;
  /** 平均超額報酬（%，未衰減） */
  avgExcess: number;
  /** 「若買進」獎勵 > 0 的比例（%） */
  winRate: number;
  /** 收縮後權重（%）；樣本不足時仍算出來給看板參考，但 active＝false */
  weight: number;
  active: boolean;
}

export function dayDiff(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
}

export function decayFactor(recordDay: string, asOfDay: string): number {
  const tradingDays = dayDiff(recordDay, asOfDay) * TRADING_DAYS_PER_CALENDAR_DAY;
  return Math.pow(0.5, tradingDays / WEIGHT_HALF_LIFE_TRADING_DAYS);
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function computeBasisStats(records: EvalRecord[], asOfDay: string): BasisStat[] {
  type Acc = { n: number; sd: number; sdx: number; sumRw: number; sumEx: number; wins: number };
  const acc = new Map<string, Acc>();
  for (const r of records) {
    const o = r.o[WEIGHT_HORIZON];
    if (!r.rg || !o || o.brw == null || o.rw == null || o.ex == null) continue;
    const d = decayFactor(r.day, asOfDay);
    for (const basis of r.bases) {
      const key = `${basis}\u0000${r.rg}`;
      const a = acc.get(key) ?? { n: 0, sd: 0, sdx: 0, sumRw: 0, sumEx: 0, wins: 0 };
      a.n++;
      a.sd += d;
      a.sdx += d * o.brw;
      a.sumRw += o.rw;
      a.sumEx += o.ex;
      if (o.brw > 0) a.wins++;
      acc.set(key, a);
    }
  }
  const out: BasisStat[] = [];
  for (const [key, a] of acc) {
    const [basis, regime] = key.split("\u0000") as [string, MarketRegime];
    out.push({
      basis,
      regime,
      n: a.n,
      neff: r2(a.sd),
      avgBuyReward: r2(a.sdx / a.sd),
      avgReward: r2(a.sumRw / a.n),
      avgExcess: r2(a.sumEx / a.n),
      winRate: Math.round((a.wins / a.n) * 100),
      weight: r2(a.sdx / (a.sd + WEIGHT_PRIOR_STRENGTH)),
      active: a.n >= WEIGHT_MIN_SAMPLES,
    });
  }
  return out.sort((x, y) => y.n - x.n || x.basis.localeCompare(y.basis));
}

/** 精簡權重表：`{依據\u0000市況: 權重}`，只收 active 的（Redis 存這份給評等讀）。 */
export type WeightTable = Record<string, number>;

export function toWeightTable(stats: BasisStat[]): WeightTable {
  return Object.fromEntries(stats.filter((s) => s.active).map((s) => [`${s.basis}\u0000${s.regime}`, s.weight]));
}

/**
 * siteRating 日後讀權重的唯一入口：一檔股票的依據鍵在目前市況下的權重加總（±WEIGHT_MAX_TOTAL_ADJUST 封頂）。
 * `enabled` 預設跟著 LEARNED_WEIGHTS_ENABLED（false＝一律回 0，不影響評等）；回測工具才會傳 true。
 */
export function learnedScoreAdjustment(
  bases: string[],
  regime: MarketRegime | null | undefined,
  table: WeightTable,
  enabled: boolean = LEARNED_WEIGHTS_ENABLED
): number {
  if (!enabled || !regime) return 0;
  let sum = 0;
  for (const b of bases) sum += table[`${b}\u0000${regime}`] ?? 0;
  return Math.max(-WEIGHT_MAX_TOTAL_ADJUST, Math.min(WEIGHT_MAX_TOTAL_ADJUST, r2(sum)));
}

export function regimeLabel(r: MarketRegime | null | undefined): string {
  return r ? REGIME_LABEL[r] : "市況未知";
}
