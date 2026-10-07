import { NextResponse, type NextRequest } from "next/server";
import { listAllAutoSims } from "@/lib/strategy/store";
import { DataCache, runSim, type RunResult } from "@/lib/strategy/runner";

/**
 * 每個交易日收盤、法人資料公布後（vercel.json：台北 16:40）依策略自動交易所有開著自動交易的模擬倉。
 * 每個模擬倉一天只跑一次（runSim 會略過今天已跑過的），所以重複觸發無害。
 * 有設 CRON_SECRET 時要帶 Authorization: Bearer <secret>（Vercel Cron 會自動帶）。
 */
export const maxDuration = 300;
/** 留時間寫回試算表，不要剛好卡在 Vercel 上限 */
const BUDGET_MS = 270_000;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const sims = await listAllAutoSims();
  const cache = new DataCache(new Set()); // 所有模擬倉共用：同一檔股票只抓一次
  const results: Array<RunResult | { simId: string; error: string }> = [];
  for (const sim of sims) {
    if (Date.now() - started > BUDGET_MS) {
      results.push({ simId: sim.id, error: "時間不夠，留給下一次排程" });
      continue;
    }
    try {
      results.push(await runSim(sim, { cache }));
    } catch (err) {
      results.push({ simId: sim.id, error: (err as Error).message });
    }
  }
  return NextResponse.json({ ok: true, count: sims.length, results });
}
