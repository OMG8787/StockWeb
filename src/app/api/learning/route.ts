import { NextRequest, NextResponse } from "next/server";
import { readEvalRecords, readLearningSummary } from "@/lib/ai/learning/learningStore";

/**
 * AI 學習循環的彙總（src/proxy.ts 密碼閘內）：
 * - GET /api/learning：成績看板彙總（每日學習工作產生；還沒跑過是 summary: null）。
 * - GET /api/learning?records=1[&from=YYYY-MM-DD&to=YYYY-MM-DD]：已算過獎勵的逐筆紀錄
 *   （scripts/update-lessons.py、scripts/backtest/weights.ts --from-site 用）。
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  try {
    if (sp.get("records") === "1") {
      const from = sp.get("from") ?? undefined;
      const to = sp.get("to") ?? undefined;
      if ((from && !DAY.test(from)) || (to && !DAY.test(to))) {
        return NextResponse.json({ error: "from／to 必須是 YYYY-MM-DD" }, { status: 400 });
      }
      const items = await readEvalRecords(from, to);
      return NextResponse.json({ count: items.length, items });
    }
    return NextResponse.json({ summary: await readLearningSummary() });
  } catch (err) {
    console.error("[learning] 讀取失敗:", err);
    return NextResponse.json({ error: "讀取學習彙總失敗" }, { status: 500 });
  }
}
