import type { NextRequest } from "next/server";
import { body, handle } from "@/lib/strategy/http";
import { previewStrategy } from "@/lib/strategy/runner";

export const maxDuration = 60;

/** 用策略判斷一檔股票（策略頁「測試一檔」）：{ strategyId, symbol } */
export const POST = (req: NextRequest) =>
  handle(req, async (o) => {
    const b = await body<{ strategyId?: string; symbol?: string }>(req);
    return previewStrategy(o.userId, String(b.strategyId ?? ""), { symbol: String(b.symbol ?? "").trim() });
  });
