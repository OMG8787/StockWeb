import type { NextRequest } from "next/server";
import { handle } from "@/lib/strategy/http";
import { getOrderBooks } from "@/lib/data/orderBook";
import { StrategyError } from "@/lib/strategy/store";

const MAX_SYMBOLS = 20;

/** 即時五檔：GET ?symbols=2330,2317（台股，最多 20 檔；前端每 5 秒刷新） */
export const GET = (req: NextRequest) =>
  handle(req, async () => {
    const symbols = (req.nextUrl.searchParams.get("symbols") ?? "").split(/[\s,]+/).filter(Boolean).slice(0, MAX_SYMBOLS);
    if (!symbols.length) throw new StrategyError("請指定股票代號");
    const books = await getOrderBooks(symbols);
    return { at: new Date().toISOString(), items: symbols.map((s) => books.get(s.toUpperCase())).filter(Boolean) };
  });
