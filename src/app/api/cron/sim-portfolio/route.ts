import { NextRequest, NextResponse } from "next/server";
import { runSimPortfolio } from "@/lib/simPortfolio/run";

/**
 * AI 模擬投資組合的執行（見 lib/simPortfolio/run.ts）。平常由 /api/cron/warm-cache（cron-job.org 每 5 分鐘）順帶觸發；
 * 這支給手動觸發，行為完全相同：只在執行時點（09:30、13:00、13:35 起）且這個時點今天還沒做過時才交易，
 * 不提供強制重跑（避免任何人重複觸發造成重複交易）。跟其他 cron 一樣：有設 CRON_SECRET 就要帶 Authorization: Bearer。
 */
export const maxDuration = 90;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runSimPortfolio();
  return NextResponse.json({ ok: result.status !== "failed", ...result }, { status: result.status === "failed" ? 503 : 200 });
}
