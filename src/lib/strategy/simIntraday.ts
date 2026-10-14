import { getMarketStatus } from "@/lib/marketStatus";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { listAllAutoSims } from "./store";
import { DataCache, runSim } from "./runner";
import { currentCheckSlot } from "./simSlots";

/**
 * 盤中型模擬倉的檢查（由 /api/cron/warm-cache 順帶呼叫，每 5 分鐘一次；不在時點窗口或休市就立刻略過、不碰資料庫）。
 * 同一時點每個模擬倉只做一次（以檢查紀錄 CheckLog 為準，重複觸發無害）；全部做完就記在記憶體，之後同一時點不再讀 Sims 表。
 */
const BUDGET_MS = 100_000;
const doneMemo = new Set<string>();

export async function runIntradaySimChecks(now: Date = new Date()): Promise<string> {
  const slot = currentCheckSlot(now);
  if (!slot || getMarketStatus("TW") !== "open") return "略過：不在盤中檢查時點";
  const day = taipeiDayKey(now);
  const memoKey = `${day}:${slot.id}`;
  if (doneMemo.has(memoKey)) return "略過：這個時點已全部檢查過";
  const sims = (await listAllAutoSims()).filter((s) => s.schedule === "intraday");
  const todo = sims.filter((s) => !s.checkLog.some((c) => c.day === day && c.slot === slot.id));
  if (todo.length === 0) {
    doneMemo.add(memoKey);
    return `略過：沒有待檢查的盤中型模擬倉（共 ${sims.length} 個，${slot.label} 都檢查過了）`;
  }
  const started = Date.now();
  const cache = new DataCache(new Set(), true); // 所有模擬倉共用：同一檔股票只抓一次
  let ok = 0;
  const errors: string[] = [];
  for (const sim of todo) {
    if (Date.now() - started > BUDGET_MS) {
      errors.push(`${sim.name}：時間不夠，留給下一次`);
      continue;
    }
    try {
      await runSim(sim, { cache, deadline: started + BUDGET_MS, mode: "intraday", slot: slot.id });
      ok++;
    } catch (err) {
      errors.push(`${sim.name}：${(err as Error).message}`);
    }
  }
  return `${slot.label} 檢查 ${ok}/${todo.length} 個模擬倉${errors.length ? `；${errors.join("；")}` : ""}`;
}
