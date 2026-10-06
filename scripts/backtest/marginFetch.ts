/**
 * 每日融資融券（逐檔、整段期間）下載：給「融資融券組合判讀」回測用（2026-10-06）。
 *   npx tsx scripts/backtest/marginFetch.ts [is|oos]
 *
 * 來源：FinMind 公開 API TaiwanStockMarginPurchaseShortSale（免費、免金鑰、不打證交所／MIS，避免本機 IP 被擋）。
 * 跟 dailyChipsFetch.ts 同一套：可續傳、循序、每筆間隔 GAP_MS（預設 13 秒；免金鑰約每小時 300 次上限）、失敗退避後仍失敗就停。
 * 存成 <cache>/daily-margin/<代號>.json：{ rows: [{ date, mb, mbPrev, sb, sbPrev, mLimit, sLimit }] }（單位：張）。
 */
import fs from "node:fs";
import path from "node:path";
import { WIDE_CACHE_DIR } from "./wideConfig";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const which = process.argv[2] === "oos" ? "oos" : "is";
const base = which === "oos" ? path.join(WIDE_CACHE_DIR, "regime-oos") : WIDE_CACHE_DIR;
const [from, to] = which === "oos" ? ["2021-07-01", "2024-11-30"] : ["2024-05-01", "2026-10-05"];
const outDir = path.join(base, "daily-margin");
fs.mkdirSync(outDir, { recursive: true });
const syms = fs.readdirSync(path.join(base, "charts")).map((f) => f.replace(/\.json$/, "")).filter((s) => /^\d{4}$/.test(s));

interface Raw {
  date: string;
  MarginPurchaseTodayBalance: number;
  MarginPurchaseYesterdayBalance: number;
  ShortSaleTodayBalance: number;
  ShortSaleYesterdayBalance: number;
  MarginPurchaseLimit: number;
  ShortSaleLimit: number;
}

async function one(sym: string) {
  const fn = path.join(outDir, `${sym}.json`);
  if (fs.existsSync(fn)) return false;
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMarginPurchaseShortSale&data_id=${sym}&start_date=${from}&end_date=${to}`;
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(url);
      const j = (await res.json()) as { status?: number; msg?: string; data?: Raw[] };
      if (res.ok && j.status === 200 && Array.isArray(j.data)) {
        const rows = j.data
          .sort((x, y) => x.date.localeCompare(y.date))
          .map((r) => ({
            date: r.date,
            mb: r.MarginPurchaseTodayBalance,
            mbPrev: r.MarginPurchaseYesterdayBalance,
            sb: r.ShortSaleTodayBalance,
            sbPrev: r.ShortSaleYesterdayBalance,
            mLimit: r.MarginPurchaseLimit,
            sLimit: r.ShortSaleLimit,
          }));
        fs.writeFileSync(fn, JSON.stringify({ rows }));
        console.log(`${which} ${sym} ${rows.length} 天`);
        return true;
      }
      console.warn(`${sym} 回應異常 ${res.status} ${j.msg ?? ""}，退避 ${90 * (a + 1)}s`);
    } catch (e) {
      console.warn(`${sym} 連線錯誤 ${(e as Error).message}，退避 ${90 * (a + 1)}s`);
    }
    await sleep(90_000 * (a + 1));
  }
  throw new Error(`${sym} 連續失敗，停止`);
}

(async () => {
  const gap = Number(process.env.GAP_MS ?? 13_000);
  for (const s of syms) if (await one(s)) await sleep(gap);
  console.log(`${which} 完成 ${syms.length} 檔`);
})();
