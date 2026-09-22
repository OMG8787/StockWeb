import { NextRequest, NextResponse } from "next/server";
import { sectorsFor, ensureTwUniverseWarm } from "@/lib/data";
import type { Market } from "@/lib/data";

export async function GET(req: NextRequest) {
  // An unrecognized value (a stale bookmark's `?market=BOGUS`) must default
  // to "TW" like a missing param does, not get cast through as a bogus
  // Market and widen the sectorsFor()/cache-key space with garbage values.
  const marketParam = req.nextUrl.searchParams.get("market");
  const market: Market = marketParam === "US" ? "US" : "TW";
  if (market === "TW") await ensureTwUniverseWarm(); // sectorsFor() 需要完整清單，不能只有SEED
  return NextResponse.json({ sectors: sectorsFor(market) });
}
