import { NextRequest, NextResponse } from "next/server";
import { kvEnabled } from "@/lib/data/kv";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { readBriefArchive } from "@/lib/ai/briefArchive";
import { privateCache } from "@/lib/apiCache";

/**
 * 今日市場快報存檔（src/proxy.ts 密碼閘內）：
 * GET /api/brief-archive?from=YYYY-MM-DD&to=YYYY-MM-DD[&grounding=1]（台北日期，含頭尾；省略 to＝今天、
 * 省略 from＝to 往前 7 天，最多 400 天）。每天一份（收盤後定稿優先），欄位見 briefArchive.ts；
 * grounding=1 才附上當時餵給 AI 的參考資料。
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const to = req.nextUrl.searchParams.get("to") ?? taipeiDayKey();
  const from =
    req.nextUrl.searchParams.get("from") ?? new Date(new Date(`${to}T00:00:00Z`).getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  if (!DAY.test(from) || !DAY.test(to) || from > to) {
    return NextResponse.json({ error: "from／to 必須是 YYYY-MM-DD，且 from ≤ to" }, { status: 400 });
  }
  try {
    const items = await readBriefArchive(from, to, req.nextUrl.searchParams.get("grounding") === "1");
    return NextResponse.json({ enabled: kvEnabled, from, to, count: items.length, items }, { headers: privateCache(300, 600) });
  } catch (err) {
    console.error("[brief-archive] 讀取失敗:", err);
    return NextResponse.json({ error: "讀取快報存檔失敗" }, { status: 500 });
  }
}
