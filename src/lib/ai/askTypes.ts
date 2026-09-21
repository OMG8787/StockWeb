import type { Market } from "@/lib/data";

export interface AskResult {
  answer: string;
  groundedSymbol?: string;
  usedAi: boolean;
}

export interface HoldingInput {
  symbol: string;
  market: Market;
  name: string;
  costBasis?: number;
  shares?: number;
}
