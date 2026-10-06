import type { Market } from "@/lib/data";
import type { ModelInfo } from "./modelName";

export interface AskResult {
  answer: string;
  groundedSymbol?: string;
  /** 問句解析出的目標代號（含個股資料抓取失敗的），診斷「有解析到卻沒有個股資料」用。 */
  resolvedTargets?: string[];
  usedAi: boolean;
  /** 實際回答的模型（usedAi 為 false 時沒有；見 modelName.ts） */
  model?: ModelInfo;
}

export interface HoldingInput {
  symbol: string;
  market: Market;
  name: string;
  costBasis?: number;
  shares?: number;
}
