import { NextRequest, NextResponse } from "next/server";
import { getChipsRatiosBatch, searchStocks } from "@/lib/data";
import type { Market, SearchFilters, VolumeTrend } from "@/lib/data";
import { getSearchSnapshot } from "@/lib/searchSnapshot";
import { toChipsBatchResponse, type ChipsRatiosBatchResponse } from "@/lib/chipsRatiosList";

/** 附籌碼比例時最多等這麼久；籌碼資料快取冷的時候寧可先回列表，前端會退回逐列漸進載入。 */
const CHIPS_ATTACH_TIMEOUT_MS = 1500;
/** 單次最多回傳筆數（分頁／重載已顯示範圍用），避免被拿來一次拉走整個市場以外的怪值。 */
const MAX_LIMIT = 5000;

const SORT_FIELDS = ["changePercent", "volume", "price", "turnover", "major", "foreign", "margin", "short"] as const;
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

  const offsetParam = numberParam(sp.get("offset"));
  const offset = offsetParam !== undefined && offsetParam > 0 ? Math.floor(offsetParam) : 0;
  const withChips = sp.get("withChips") === "1";
  const snapshotParam = sp.get("snapshot");

  try {
    const filters: SearchFilters = {
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
    };
    // 快照 key＝所有篩選＋排序參數（JSON 會略過 undefined）；分頁參數不在內。
    const { id: snapshot, items: all } = await getSearchSnapshot(JSON.stringify(filters), () => searchStocks(filters), snapshotParam);
    const end = limit !== undefined ? offset + Math.min(limit, MAX_LIMIT) : undefined;
    const items = offset > 0 || end !== undefined ? all.slice(offset, end) : all;

    let chips: ChipsRatiosBatchResponse | undefined;
    if (withChips) {
      const twSymbols = items.filter((i) => i.market === "TW").map((i) => i.symbol);
      if (twSymbols.length > 0) {
        chips = await Promise.race([
          getChipsRatiosBatch(twSymbols).then(toChipsBatchResponse),
          new Promise<undefined>((resolve) => setTimeout(resolve, CHIPS_ATTACH_TIMEOUT_MS)),
        ]).catch(() => undefined);
      }
    }
    return NextResponse.json({ items, total: all.length, offset, snapshot, ...(chips ? { chips } : {}) });
  } catch (err) {
    console.error("[search] searchStocks failed:", err);
    return NextResponse.json({ error: "搜尋時發生錯誤" }, { status: 500 });
  }
}
