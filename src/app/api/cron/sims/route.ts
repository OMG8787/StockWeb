import { NextResponse, type NextRequest } from "next/server";
import { listAllAutoSims } from "@/lib/strategy/store";
import { DataCache, runSim, type RunResult } from "@/lib/strategy/runner";
import { searchStocks } from "@/lib/data";

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
  // 順便觸發全市場報價表（收盤後會記一筆每日成交量，股票篩選的 5 日均量／當週／當月靠它累積），
  // 不必依賴外部預熱排程
  await searchStocks({ market: "TW", sortBy: "volume", sortDir: "desc" }).catch(() => []);
  let sims;
  try {
    sims = await listAllAutoSims();
  } catch (err) {
    // 例如試算表的 Apps Script 還是舊版、不認得 Sims 表
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
  const cache = new DataCache(new Set()); // 所有模擬倉共用：同一檔股票只抓一次
  const results: Array<RunResult | { simId: string; error: string }> = [];
  for (const sim of sims) {
    if (Date.now() - started > BUDGET_MS) {
      results.push({ simId: sim.id, error: "時間不夠，留給下一次排程" });
      continue;
    }
    try {
      // 每個模擬倉抓資料的期限＝整體剩餘時間，留 30 秒寫回
      results.push(await runSim(sim, { cache, deadline: started + BUDGET_MS - 30_000 }));
    } catch (err) {
      results.push({ simId: sim.id, error: (err as Error).message });
    }
  }
  return NextResponse.json({ ok: true, count: sims.length, results });
}
