import { NextRequest, NextResponse } from "next/server";
import { getStockRatings } from "@/lib/ai/stockRating";
import { operationAdvice, type OperationAdvice } from "@/lib/ai/operationAdvice";
import { privateCache } from "@/lib/apiCache";
import { quoteBatchKey } from "@/lib/quotesBatchApi";
import type { Market } from "@/lib/data";

export const maxDuration = 60;

/** 一次最多幾檔（關注清單通常十幾檔；評等有 10 分鐘快取，第一次冷算會比較慢） */
const MAX_ITEMS = 60;
/** 冷算最多等這麼久，沒算完的標成 pending，前端 20 秒後再來拿（算好的已進評等快取） */
const DEADLINE_MS = 25_000;

export interface WatchAdviceResponse {
  /** key＝`${market}:${symbol}`；沒有評等（資料不足）的不在裡面 */
  items: Record<string, OperationAdvice>;
  /** 這次還沒算完的 key */
  pending: string[];
}

/**
 * 關注清單「操作建議」欄：`?items=TW:2330:1,US:AAPL:0`（第三段 1＝你有填持有股數與成本、0＝只是關注）。
 * 結論來自本站綜合評等（getStockRatings＝跟個股頁同一份），翻成買／賣／續抱／不買與是否需觀察見 operationAdvice.ts。
 */
export async function GET(req: NextRequest) {
  const wanted: Array<{ market: Market; symbol: string; held: boolean }> = [];
  const seen = new Set<string>();
  for (const part of (req.nextUrl.searchParams.get("items") ?? "").split(",")) {
    const [m, s, h] = part.trim().split(":");
    const symbol = (s ?? "").trim().toUpperCase();
    if ((m !== "TW" && m !== "US") || !/^[A-Z0-9.\-^=]{1,15}$/.test(symbol)) continue;
    const key = quoteBatchKey(m, symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push({ market: m, symbol, held: h === "1" });
    if (wanted.length >= MAX_ITEMS) break;
  }
  if (wanted.length === 0) return NextResponse.json({ error: "請提供 items=TW:2330:0" }, { status: 400 });

  const items: Record<string, OperationAdvice> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([
    getStockRatings(wanted.map((w) => ({ symbol: w.symbol, market: w.market })), 3).then((m) => m),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), DEADLINE_MS);
    }),
  ]);
  clearTimeout(timer);
  if (done) {
    for (const w of wanted) {
      const r = done.get(w.symbol);
      if (r) items[quoteBatchKey(w.market, w.symbol)] = operationAdvice(r.rating, w.held);
    }
  }
  const pending = done ? [] : wanted.map((w) => quoteBatchKey(w.market, w.symbol));
  const body: WatchAdviceResponse = { items, pending };
  // 算完才快取 2 分鐘；還有 pending 的不快取，前端很快會再來問
  return NextResponse.json(body, { headers: done ? privateCache(120, 300) : { "Cache-Control": "no-store" } });
}
