import type { NextRequest } from "next/server";
import { body, handle } from "@/lib/strategy/http";
import { getSim, StrategyError } from "@/lib/strategy/store";
import { manualTrade } from "@/lib/strategy/runner";

/** 手動下單：{ side: "buy" | "sell", symbol, shares }，以最新報價成交 */
export const POST = (req: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  handle(req, async (o) => {
    const { id } = await params;
    const b = await body<{ side?: string; symbol?: string; shares?: number }>(req);
    if (b.side !== "buy" && b.side !== "sell") throw new StrategyError("side 必須是 buy 或 sell");
    const symbol = String(b.symbol ?? "").trim().toUpperCase();
    if (!symbol) throw new StrategyError("請輸入股票代號");
    return manualTrade(await getSim(o.userId, id), { side: b.side, symbol, shares: Number(b.shares) });
  });
