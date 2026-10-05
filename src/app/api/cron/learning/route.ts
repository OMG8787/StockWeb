import { NextRequest, NextResponse } from "next/server";
import { runLearningUpdate } from "@/lib/ai/learning/learningStore";

/**
 * 每日學習工作（評等紀錄 → 獎勵 → 依據權重／相似案例／教訓驗證／成績看板彙總），見 learning/learningStore.ts。
 * 平常由 /api/cron/warm-cache 順便觸發（收盤後一天一次）；這支給手動觸發：`?force=1` 不檢查時段與「今天已做完」。
 * 跟其他 cron 一樣：有設 CRON_SECRET 就要帶 Authorization: Bearer。
 */
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runLearningUpdate({ force: req.nextUrl.searchParams.get("force") === "1" });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron] learning failed:", err);
    return NextResponse.json({ ok: false, error: "學習工作失敗" }, { status: 503 });
  }
}
