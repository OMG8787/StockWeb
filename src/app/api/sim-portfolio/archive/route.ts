import { NextRequest, NextResponse } from "next/server";
import { readSimArchive, type SimArchiveKind } from "@/lib/simPortfolio/archive";
import { kvEnabled } from "@/lib/data/kv";

/**
 * AI 模擬投資組合的永久封存（密碼閘內）：GET /api/sim-portfolio/archive?kind=trades|decisions|daily&month=YYYY-MM
 * 一次讀一個月（交易、決策紀錄是 list，每日快照是 hash）。/portfolio「完整紀錄」與 scripts/check-sim-portfolio.py 用。
 */
const KINDS: SimArchiveKind[] = ["trades", "decisions", "daily"];

export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get("kind") as SimArchiveKind | null;
  const month = req.nextUrl.searchParams.get("month") ?? "";
  if (!kind || !KINDS.includes(kind) || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "kind 必須是 trades／decisions／daily，month 必須是 YYYY-MM" }, { status: 400 });
  }
  try {
    const items =
      kind === "trades" ? await readSimArchive("trades", month) : kind === "decisions" ? await readSimArchive("decisions", month) : await readSimArchive("daily", month);
    return NextResponse.json({ enabled: kvEnabled, kind, month, count: items.length, items });
  } catch (err) {
    console.error("[sim-portfolio] 封存讀取失敗:", err);
    return NextResponse.json({ error: "讀取封存失敗" }, { status: 500 });
  }
}
