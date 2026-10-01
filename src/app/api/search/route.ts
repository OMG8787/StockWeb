import { NextRequest, NextResponse } from "next/server";
import { searchStocks } from "@/lib/data";
import type { Market, VolumeTrend } from "@/lib/data";

const SORT_FIELDS = ["changePercent", "volume", "price", "turnover", "major", "foreign", "margin"] as const;
type SortField = (typeof SORT_FIELDS)[number];

const VOLUME_TRENDS = ["buy-leaning", "sell-leaning", "neutral"] as const;

/**
 * A parameter that doesn't parse is treated as "not supplied" rather than
 * passed through as NaN. `Number("abc")` is NaN, and every comparison
 * against NaN is false — so a single malformed value (a half-typed number,
 * a stale bookmark) silently filtered out *every* stock and the page just
 * said "共 0 筆" as though the market had nothing matching.
 */
function numberParam(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const marketParam = sp.get("market");
  const market: Market | undefined = marketParam === "TW" || marketParam === "US" ? marketParam : undefined;
  const sectorsParam = sp.get("sectors");
  const sectors = sectorsParam ? sectorsParam.split(",").filter(Boolean) : undefined;
  const query = sp.get("q");

  const volumeTrendsParam = sp.get("volumeTrends");
  // Whitelisted the same way sortBy is above: filters into a Set comparison,
  // but an unrecognized value should just be dropped, not silently accepted
  // as a trend that will never match anything.
  const volumeTrends = volumeTrendsParam
    ? (volumeTrendsParam.split(",").filter((v): v is VolumeTrend => (VOLUME_TRENDS as readonly string[]).includes(v)))
    : undefined;

  const sortByParam = sp.get("sortBy");
  // Whitelisted: this value indexes into the item objects when sorting, so
  // an arbitrary string would read whatever property it names.
  const sortBy = SORT_FIELDS.includes(sortByParam as SortField) ? (sortByParam as SortField) : undefined;
  const sortDirParam = sp.get("sortDir");
  const sortDir = sortDirParam === "asc" || sortDirParam === "desc" ? sortDirParam : undefined;

  const limitParam = numberParam(sp.get("limit"));
  const limit = limitParam !== undefined && limitParam > 0 ? Math.floor(limitParam) : undefined;

  try {
    const items = await searchStocks({
      market,
      sectors,
      query: query ?? undefined,
      minChangePercent: numberParam(sp.get("min")),
      maxChangePercent: numberParam(sp.get("max")),
      minPrice: numberParam(sp.get("minPrice")),
      maxPrice: numberParam(sp.get("maxPrice")),
      minVolume: numberParam(sp.get("minVolume")),
      maxVolume: numberParam(sp.get("maxVolume")),
      minTurnover: numberParam(sp.get("minTurnover")),
      maxTurnover: numberParam(sp.get("maxTurnover")),
      volumeTrends,
      sortBy,
      sortDir,
    });
    return NextResponse.json({ items: limit !== undefined ? items.slice(0, limit) : items });
  } catch (err) {
    console.error("[search] searchStocks failed:", err);
    return NextResponse.json({ error: "搜尋時發生錯誤" }, { status: 500 });
  }
}
