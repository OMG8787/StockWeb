import { NextRequest, NextResponse } from "next/server";
import { getActionBrief } from "@/lib/ai/actionBrief";

// Mirrors api/daily-brief: generation fans out several already-cached data
// fetches plus one AI call comfortably past Vercel's ~10s default budget.
// 2026-10-08：新 Vercel 專案還沒有 Redis 時，冷快取要替整批候選股算評等，盤中實測超過 60 秒被中斷（504），
// 卡片一直停在載入中；放寬到 Hobby 上限 300 秒（不收費，只是用量），算完會留在記憶體快取，之後就快。
export const maxDuration = 300;

// Backs the client-side fetch in ActionBriefCard — kept off the page's
// server-rendered blocking path for the same reason as DailyBriefCard.
// `?refresh=1` forces regeneration, overwriting whatever is currently
// cached, without waiting out the 20-minute TTL.
export async function GET(req: NextRequest) {
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";
  try {
    const actionBrief = await getActionBrief(forceRefresh);
    return NextResponse.json({ actionBrief });
  } catch (err) {
    console.error("[api/action-brief] failed:", err);
    return NextResponse.json({ error: "今日建議暫時無法取得" }, { status: 503 });
  }
}
