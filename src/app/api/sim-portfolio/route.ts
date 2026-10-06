import { NextRequest, NextResponse } from "next/server";
import { getSimPortfolioView } from "@/lib/simPortfolio/view";

/**
 * AI 模擬投資組合（首頁卡片、/portfolio 頁）：`?trades=N` 只回最近 N 筆交易（首頁卡片用，省流量）。
 * 不加 Cache-Control：盤中輪詢要拿到新的淨值；Redis 讀取在 view 層每個執行個體快取 60 秒，報價走既有快取。
 */
export async function GET(req: NextRequest) {
  const n = Number(req.nextUrl.searchParams.get("trades"));
  try {
    const view = await getSimPortfolioView({ tradeLimit: Number.isFinite(n) && n > 0 ? Math.min(n, 400) : undefined });
    return NextResponse.json(view);
  } catch (err) {
    console.error("[api] sim-portfolio failed:", err);
    return NextResponse.json({ error: "模擬投資組合暫時無法取得" }, { status: 503 });
  }
}
