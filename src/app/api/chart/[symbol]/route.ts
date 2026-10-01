import { NextRequest, NextResponse } from "next/server";
import { getChart, getLastChartFailure } from "@/lib/data";
import type { ChartRange, Market } from "@/lib/data";

const VALID_RANGES: ChartRange[] = ["today", "5d", "10d", "1m", "3m", "6m", "1y", "2y", "5y", "10y"];
// A cold 5y/10y TW/TPEx chart fans out into up to 60-120 bounded-concurrency
// (10 at a time — see MONTH_FETCH_CONCURRENCY in twse.ts/tpex.ts) monthly
// requests, which can comfortably exceed Vercel's ~10s Node function
// default — same reasoning as api/daily-brief's maxDuration.
export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const rangeParam = req.nextUrl.searchParams.get("range") ?? "3m";
  const marketParam = req.nextUrl.searchParams.get("market");
  // See the identical guard in /api/quote — an unrecognized value must fall
  // through to undefined so getChart auto-detects, rather than being cast
  // through as a bogus Market.
  const market: Market | undefined = marketParam === "TW" || marketParam === "US" ? marketParam : undefined;
  const range = VALID_RANGES.includes(rangeParam as ChartRange) ? (rangeParam as ChartRange) : "3m";

  if (!symbol) {
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  }
  try {
    const chart = await getChart(symbol, range, market);
    if (!chart) {
      return NextResponse.json(
        { error: "目前無法取得歷史圖表資料", detail: getLastChartFailure(symbol, range, market) },
        { status: 503 }
      );
    }
    return NextResponse.json(chart);
  } catch (err) {
    console.error("[chart] getChart failed:", err);
    return NextResponse.json({ error: "取得圖表資料時發生錯誤" }, { status: 500 });
  }
}
