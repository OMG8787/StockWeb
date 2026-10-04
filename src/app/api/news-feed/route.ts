import { NextRequest, NextResponse } from "next/server";
import { getNewsFeed, NEWS_FEED_PAGE_SIZE, summarizeItems } from "@/lib/ai/newsfeed";

// Building the pool fans out to a dozen+ Google News requests plus an AI
// classification call on a cache-cold generation — same reasoning as
// api/daily-brief's maxDuration bump.
export const maxDuration = 60;

const DEFAULT_LIMIT = NEWS_FEED_PAGE_SIZE;
const MAX_LIMIT = 50;

/**
 * Backs the infinite-scroll list on /news. `pinned` is only included on the
 * first page (offset 0) — later pages just page through `items`, which
 * already excludes whatever was pinned so nothing repeats. `?refresh=1`
 * forces the underlying feed to regenerate (see getNewsFeed/cache.ts
 * forceRefresh), the same manual escape hatch as /api/daily-brief.
 */
export async function GET(req: NextRequest) {
  const offset = Math.max(0, Number.parseInt(req.nextUrl.searchParams.get("offset") ?? "0", 10) || 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10) || DEFAULT_LIMIT));
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";

  try {
    const feed = await getNewsFeed(forceRefresh);
    const page = await summarizeItems(feed.items.slice(offset, offset + limit));
    return NextResponse.json({
      pinned: offset === 0 ? feed.pinned : [],
      items: page,
      hasMore: offset + limit < feed.items.length,
      generatedAt: feed.generatedAt,
    });
  } catch (err) {
    console.error("[api/news-feed] failed:", err);
    return NextResponse.json({ error: "新聞暫時無法取得" }, { status: 503 });
  }
}
