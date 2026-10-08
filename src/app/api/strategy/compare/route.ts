import type { NextRequest } from "next/server";
import { body, handle } from "@/lib/strategy/http";
import { compareStrategies } from "@/lib/strategy/compare";

export const maxDuration = 300;

/** 策略疊圖：{ symbols: string[], strategyIds: string[] }（strategyIds 可含 "ai"） */
export const POST = (req: NextRequest) =>
  handle(req, async (o) => {
    const b = await body<{ symbols?: unknown; strategyIds?: unknown }>(req);
    const symbols = Array.isArray(b.symbols) ? b.symbols.map(String) : [];
    const strategyIds = Array.isArray(b.strategyIds) ? b.strategyIds.map(String) : [];
    return { rows: await compareStrategies(o.userId, symbols, strategyIds) };
  });
