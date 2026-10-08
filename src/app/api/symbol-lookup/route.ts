import { NextRequest, NextResponse } from "next/server";
import { ensureTwUniverseWarm, searchUniverseByQuery } from "@/lib/data";
import { privateCache } from "@/lib/apiCache";

/**
 * 頂部搜尋框的「輸入名稱 → 列出所有比對到的股票」用的輕量端點。
 *
 * 刻意不重用 /api/search：那支會對整個清單批次抓即時報價（昂貴、有上游併發成本），
 * 這裡只需要「名字對得上的有哪幾檔」這種純記憶體字典比對，不碰任何報價來源，
 * 所以每次按鍵都打也不會對上游造成負擔。
 *
 * 一定要先 await ensureTwUniverseWarm()：searchUniverseByQuery 讀的是模組層級的
 * 快照，只有真的warm過的instance才會被填滿完整官方清單，否則會靜默退回一份
 * 很小的SEED清單——這正是 PROGRESS.md 2026-09-14「美利達查不到」那次踩過的坑。
 */
const MAX_RESULTS = 20;

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ results: [] });
  await ensureTwUniverseWarm();
  const results = searchUniverseByQuery(q, MAX_RESULTS).map((entry) => ({
    symbol: entry.symbol,
    name: entry.name,
    market: entry.market,
    exchange: entry.exchange,
  }));
  return NextResponse.json({ results }, { headers: privateCache(3600, 86400) }); // 代號／名稱字典一天才變一次
}
