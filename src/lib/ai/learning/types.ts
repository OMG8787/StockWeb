import type { RatingCode } from "../siteRating";
import type { RatingFeatures } from "./features";
import type { MarketRegime } from "./regime";
import type { HorizonOutcome } from "./reward";

/**
 * 一筆「已算過獎勵」的評等（Redis `learning:v1:eval:{台北日期}`，field 同評等紀錄 `{代號}#{結論}`）。
 * 由每日學習工作（learningStore.ts）從評等紀錄＋事後日K產生；權重、相似案例、教訓驗證、成績看板都只讀這份。
 */
export interface EvalRecord {
  /** 評等時間（UTC ISO） */
  at: string;
  day: string;
  sym: string;
  name: string;
  code: RatingCode;
  price: number;
  /** 市況；舊紀錄沒有是 null */
  rg: MarketRegime | null;
  /** 判斷依據鍵（features.ts featureBases） */
  bases: string[];
  /** 判斷依據原始特徵（教訓驗證用；舊紀錄沒有） */
  f?: RatingFeatures;
  /** 相似案例比對鍵（features.ts similarKey） */
  sk: string | null;
  /** 各期間結果；key 是交易日數（"1"／"5"／"20"），還沒滿期就沒有 */
  o: Partial<Record<"1" | "5" | "20", HorizonOutcome>>;
  /** 第二階段預留：AI 調整後結論與其獎勵（冠軍／挑戰者比較用） */
  ai?: { code: RatingCode; delta: number; o?: Partial<Record<"1" | "5" | "20", HorizonOutcome>> };
}
