import type { Market } from "@/lib/data";
import type { ModelInfo } from "./modelName";
import type { SaleRecord } from "@/lib/soldRecords";

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
  /** 買進日（YYYY-MM-DD 台北；停利規則只看這天之後的日K，沒有就不觸發停利） */
  buyDate?: string;
  /** 賣出紀錄（關注清單「已賣出」；AI 的已賣出區塊用，見 grounding/soldHoldings.ts） */
  sales?: SaleRecord[];
}
