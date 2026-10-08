import { NextRequest, NextResponse } from "next/server";
import { getDailyBrief } from "@/lib/ai/brief";

// Brief generation now allows up to a 25s Gemini call (see brief.ts) — this
// route's own execution budget needs enough room for that plus the data
// fetches ahead of it, well past Vercel's ~10s default for a Node function.
// 2026-10-08：新 Vercel 專案還沒有 Redis 時，冷快取要替整批候選股算評等，盤中實測超過 60 秒被中斷（504），
// 卡片一直停在載入中；放寬到 Hobby 上限 300 秒（不收費，只是用量），算完會留在記憶體快取，之後就快。
export const maxDuration = 300;

// Backs the client-side fetch in DailyBriefCard — see that component for why
// this moved off the homepage's server-rendered blocking path (the brief
// generation call is the slowest thing on the page on a cache-cold day, same
// class of problem MomentumSection solved for /highlights).
// `?refresh=1` forces regeneration, overwriting whatever is currently
// cached — a manual escape hatch for clearing out a bad cached value (e.g. a
// response truncated by the output-token cap) without waiting out the ~25h
// TTL. Gated by the same password-gate cookie as everything else on the
// site, not separately restricted.
export async function GET(req: NextRequest) {
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";
  try {
    const brief = await getDailyBrief(forceRefresh);
    return NextResponse.json({ brief });
  } catch (err) {
    console.error("[api/daily-brief] failed:", err);
    return NextResponse.json({ error: "快報暫時無法取得" }, { status: 503 });
  }
}
