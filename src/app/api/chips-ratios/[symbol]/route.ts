import { NextRequest, NextResponse } from "next/server";
import { getChipsRatios } from "@/lib/data";
import type { Market } from "@/lib/data";

/**
 * 個股「籌碼比例」摘要（融資使用率／外資持股比例／大戶持股比例＋前一期）的 JSON 版。
 * 個股頁本身是 server component 直接呼叫 getChipsRatios()，不經過這支；這支給
 * curl 對帳與之後其他前端用。TW only，美股回 404。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const marketParam = req.nextUrl.searchParams.get("market");
  const market: Market | undefined = marketParam === "TW" || marketParam === "US" ? marketParam : undefined;
  if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  try {
    const ratios = await getChipsRatios(symbol, market);
    if (!ratios) return NextResponse.json({ error: "資料暫缺" }, { status: 404 });
    return NextResponse.json(ratios);
  } catch (err) {
    console.error("[chips-ratios] failed:", err);
    return NextResponse.json({ error: "取得籌碼比例時發生錯誤" }, { status: 500 });
  }
}
