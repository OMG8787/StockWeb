import { NextRequest, NextResponse } from "next/server";
import { getQuote, findInUniverse, getTwUniverse } from "@/lib/data";
import type { Market } from "@/lib/data";

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
    const quote = await getQuote(symbol, market);
    if (!quote) {
      return NextResponse.json({ error: "目前無法取得即時報價" }, { status: 503 });
    }
    // Quote 本身沒有 sector 欄位（單檔即時報價的上游端點不會回產業別），但
    // 關注清單需要真實產業別來取代寫死的「自選」——這裡另外查一次官方股票
    // 清單附加上去，不動 Quote 型別本身（避免影響其他用到 getQuote 的地方）。
    //
    // findInUniverse() 讀的是 lib/data/universe.ts 裡一個模組層級的同步快照
    // （twFullCompanySnapshot），這個快照在 getTwUniverse() 第一次真的跑過
    // 之前，只是一份很小的內建 SEED 清單（信驊/恩德/順德/光罩/全友這類非
    // 超大型權值股都不在裡面）。Vercel 是很多短命的無伺服器實例，一個實例
    // 只要還沒剛好執行過 getTwUniverse()，這裡就會一路查不到、悄悄退回
    // undefined，畫面上就變成看起來像沒修好的「自選」——跟 symbolResolve.ts
    // 裡 guessSymbolsFromText() 早就踩過、也修過的同一個坑（那邊的註解有
    // 完整說明）。這裡先 await 一次同一份 getTwUniverse()，確保用的是真正
    // 完整的官方清單；這份資料是 Redis 快取（所有實例共用），不是第一次
    // 冷啟動的話這裡幾乎是免費的快取命中，不會拖慢這支高頻率被打的報價
    // API。美股 US_UNIVERSE 本來就是靜態內建清單，不需要這個步驟。
    if (quote.market === "TW") await getTwUniverse().catch(() => undefined);
    const sector = findInUniverse(quote.symbol, quote.market)?.sector;
    return NextResponse.json(sector ? { ...quote, sector } : quote);
  } catch (err) {
    console.error("[quote] getQuote failed:", err);
    return NextResponse.json({ error: "取得報價時發生錯誤" }, { status: 500 });
  }
}
