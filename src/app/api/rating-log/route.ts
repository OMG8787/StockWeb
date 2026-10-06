import { NextRequest, NextResponse } from "next/server";
import { kvEnabled } from "@/lib/data/kv";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { readRatingLog } from "@/lib/ai/ratingLog";

/**
 * 本站綜合評等紀錄（src/proxy.ts 密碼閘內）：
 * GET /api/rating-log?from=YYYY-MM-DD&to=YYYY-MM-DD（台北日期，含頭尾；省略 to＝今天、省略 from＝to 往前 7 天，
 * 最多 400 天）。一天一個 hash，整段用一個 pipeline 讀。scripts/check-rating-log.py 用這支。
 * 可加 `symbols=2330,2317`（最多 50 檔，大小寫不拘）只回這幾檔——關注清單「已賣出」查賣出當天的本站建議用。
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
    const symbolsParam = req.nextUrl.searchParams.get("symbols");
    const wanted = symbolsParam
      ? new Set(symbolsParam.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean).slice(0, 50))
      : null;
    const all = await readRatingLog(from, to);
    const items = wanted ? all.filter((e) => wanted.has(e.symbol.toUpperCase())) : all;
    return NextResponse.json({ enabled: kvEnabled, from, to, count: items.length, items });
  } catch (err) {
    console.error("[rating-log] 讀取失敗:", err);
    return NextResponse.json({ error: "讀取評等紀錄失敗" }, { status: 500 });
  }
}
