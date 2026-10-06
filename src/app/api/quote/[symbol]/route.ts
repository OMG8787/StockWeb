import { NextRequest, NextResponse } from "next/server";
import { getQuote, findInUniverse } from "@/lib/data";
import type { Market } from "@/lib/data";
import { withLivePollWait } from "@/lib/data/livePollContext";

export async function GET(req: NextRequest, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const marketParam = req.nextUrl.searchParams.get("market");
  // An unrecognized value must fall through to undefined (letting getQuote
  // auto-detect from the symbol), not get cast straight through as Market —
  // a stale bookmark's `?market=BOGUS` would otherwise silently query the
  // wrong market's data source instead of guessing correctly.
  const market: Market | undefined = marketParam === "TW" || marketParam === "US" ? marketParam : undefined;
  if (!symbol) {
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  }
  try {
    // 前端輪詢帶 x-live-poll：過期值多等一下拿新值（見 lib/livePoll.ts）；首次載入維持 1.5 秒。
    const quote = await withLivePollWait(req, () => getQuote(symbol, market));
    if (!quote) {
      return NextResponse.json({ error: "目前無法取得即時報價" }, { status: 503 });
    }
    // Quote 本身沒有 sector 欄位（單檔即時報價的上游端點不會回產業別），但
    // 關注清單需要真實產業別來取代寫死的「自選」——這裡另外查一次官方股票
    // 清單附加上去，不動 Quote 型別本身（避免影響其他用到 getQuote 的地方）。
    // findInUniverse() 讀的官方清單快取，getQuote() 內部已經確保 TW 市場
    // 一定warm過（見 quote.ts 的說明），這裡不用再自己重複warm一次。
    const sector = findInUniverse(quote.symbol, quote.market)?.sector;
    return NextResponse.json(sector ? { ...quote, sector } : quote);
  } catch (err) {
    console.error("[quote] getQuote failed:", err);
    return NextResponse.json({ error: "取得報價時發生錯誤" }, { status: 500 });
  }
}
