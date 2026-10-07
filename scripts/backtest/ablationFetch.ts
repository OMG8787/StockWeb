/**
 * 消融實驗補資料（2026-10-07）：月營收（樣本外）與每日本益比／殖利率（兩段），逐檔下載。
 *   npx tsx scripts/backtest/ablationFetch.ts revenue oos
 *   npx tsx scripts/backtest/ablationFetch.ts per is|oos
 *
 * 來源：FinMind 公開 API（免費、免金鑰、不打證交所／MIS）。TaiwanStockMonthRevenue／TaiwanStockPER。
 * 跟 marginFetch.ts 同一套：可續傳、循序、每筆間隔 GAP_MS（預設 13 秒；免金鑰約每小時 300 次上限，撞 402 就退避）。
 * 存檔：<cache>/fm-revenue/<代號>.json：{ rows: [{ y, m, rev }] }（營收所屬年月；公布日由回測端用「次月 10 日」保守對齊）
 *       <cache>/fm-per/<代號>.json：{ rows: [{ date, pe, pb, dy }] }（證交所每日盤後公布，當天收盤後可得）
 */
import fs from "node:fs";
import path from "node:path";
import { WIDE_CACHE_DIR } from "./wideConfig";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kind = process.argv[2] === "per" ? "per" : "revenue";
const which = process.argv[3] === "oos" ? "oos" : "is";
const GAP_MS = Number(process.env.GAP_MS ?? 13_000);
const base = which === "oos" ? path.join(WIDE_CACHE_DIR, "regime-oos") : WIDE_CACHE_DIR;
const [from, to] =
  kind === "revenue"
    ? which === "oos" ? ["2020-11-01", "2024-11-30"] : ["2023-06-01", "2026-10-05"]
    : which === "oos" ? ["2021-12-01", "2024-09-30"] : ["2024-09-01", "2026-08-31"];
const outDir = path.join(base, kind === "per" ? "fm-per" : "fm-revenue");
fs.mkdirSync(outDir, { recursive: true });
const syms = fs.readdirSync(path.join(base, "daily-chips")).map((f) => f.replace(/\.json$/, "")).filter((s) => /^\d{4}$/.test(s));

async function one(sym: string): Promise<boolean> {
  const fn = path.join(outDir, `${sym}.json`);
  if (fs.existsSync(fn)) return false;
  const ds = kind === "per" ? "TaiwanStockPER" : "TaiwanStockMonthRevenue";
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=${ds}&data_id=${sym}&start_date=${from}&end_date=${to}`;
  for (let a = 0; a < 6; a++) {
    try {
      const res = await fetch(url);
      const j = (await res.json()) as { status?: number; msg?: string; data?: Record<string, number | string>[] };
      if (res.ok && j.status === 200 && Array.isArray(j.data)) {
        const rows =
          kind === "per"
            ? j.data
                .map((r) => ({ date: String(r.date), pe: Number(r.PER), pb: Number(r.PBR), dy: Number(r.dividend_yield) }))
                .sort((x, y) => x.date.localeCompare(y.date))
            : j.data
                .map((r) => ({ y: Number(r.revenue_year), m: Number(r.revenue_month), rev: Number(r.revenue) }))
                .sort((x, y) => x.y - y.y || x.m - y.m);
        fs.writeFileSync(fn, JSON.stringify({ rows }));
        console.log(`${kind} ${which} ${sym} ${rows.length}`);
        return true;
      }
      console.warn(`${sym} 回應異常 ${res.status} ${j.msg ?? ""}，退避 ${90 * (a + 1)}s`);
    } catch (e) {
      console.warn(`${sym} 連線錯誤 ${(e as Error).message}，退避 ${90 * (a + 1)}s`);
    }
    await sleep(90_000 * (a + 1));
  }
  throw new Error(`${sym} 連續失敗，停止（可續傳）`);
}

(async () => {
  let n = 0;
  for (const s of syms) if (await one(s)) { n++; await sleep(GAP_MS); }
  console.log(`完成 ${kind} ${which}：新增 ${n} 檔，共 ${syms.length}`);
})();
