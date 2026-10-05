import type { Market } from "@/lib/data";
import type { ModelInfo } from "./modelName";

export interface AskResult {
  answer: string;
  groundedSymbol?: string;
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
