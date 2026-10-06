import { NextRequest, NextResponse } from "next/server";
import { getQuotesBatch } from "@/lib/data";
import { withLivePollWait } from "@/lib/data/livePollContext";
import {
  QUOTES_BATCH_MAX_SYMBOLS,
  parseQuotesBatchItems,
  quoteBatchKey,
  type QuotesBatchResponse,
} from "@/lib/quotesBatchApi";

/**
 * 關注清單的批次報價：`/api/quotes?items=TW:2330,US:AAPL`，單次最多 QUOTES_BATCH_MAX_SYMBOLS 檔。
 * 上市櫃查已快取的全市場報價表，其餘退回單檔報價（見 lib/data/quoteBatch.ts）。
 * 不加 Cache-Control：盤中每 30 秒輪詢要拿到新數字，新鮮度由資料層 TTL 控制
 * （跟 /api/quote/[symbol] 一樣）。
 */
export async function GET(req: NextRequest) {
  const requests = parseQuotesBatchItems(req.nextUrl.searchParams.get("items") ?? "");
  if (requests.length === 0) {
    return NextResponse.json({ error: "請提供 items=TW:2330,US:AAPL" }, { status: 400 });
  }
  if (requests.length > QUOTES_BATCH_MAX_SYMBOLS) {
    return NextResponse.json({ error: `單次最多 ${QUOTES_BATCH_MAX_SYMBOLS} 檔` }, { status: 400 });
  }
  try {
    const quotes = await withLivePollWait(req, () => getQuotesBatch(requests));
    const body: QuotesBatchResponse = { items: {} };
    requests.forEach((r, i) => {
      body.items[quoteBatchKey(r.market, r.symbol)] = quotes[i];
    });
    return NextResponse.json(body);
  } catch (err) {
    console.error("[quotes batch] failed:", err);
    return NextResponse.json({ error: "取得報價時發生錯誤" }, { status: 500 });
  }
}
