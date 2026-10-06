/**
 * 每日三大法人（逐檔、整段期間）下載：給「評等穩定化」回測量每日翻轉次數與 N 日累計籌碼用（2026-10-06）。
 *   npx tsx scripts/backtest/dailyChipsFetch.ts [is|oos]
 *
 * 來源：FinMind 公開 API（免費、免金鑰、不打證交所／MIS，避免本機 IP 被擋）。可續傳：已存在的檔跳過。
 * 循序、每筆間隔 12 秒（GAP_MS 可調；免金鑰約每小時 300 次上限，兩段同時跑時加大間隔），失敗退避後仍失敗就停。
 * 存成 <cache>/daily-chips/<代號>.json：{ rows: [{ date, inst, foreign, trust }] }（單位：股）。
 */
import fs from "node:fs";
import path from "node:path";
import { WIDE_CACHE_DIR } from "./wideConfig";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const which = process.argv[2] === "oos" ? "oos" : "is";
const base = which === "oos" ? path.join(WIDE_CACHE_DIR, "regime-oos") : WIDE_CACHE_DIR;
const [from, to] = which === "oos" ? ["2021-07-01", "2024-11-30"] : ["2024-05-01", "2026-10-05"];
const outDir = path.join(base, "daily-chips");
fs.mkdirSync(outDir, { recursive: true });
const syms = fs.readdirSync(path.join(base, "charts")).map((f) => f.replace(/\.json$/, "")).filter((s) => /^\d{4}$/.test(s));

interface Raw { date: string; name: string; buy: number; sell: number }

async function one(sym: string) {
  const fn = path.join(outDir, `${sym}.json`);
  if (fs.existsSync(fn)) return false;
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInstitutionalInvestorsBuySell&data_id=${sym}&start_date=${from}&end_date=${to}`;
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(url);
      const j = (await res.json()) as { status?: number; msg?: string; data?: Raw[] };
      if (res.ok && j.status === 200 && Array.isArray(j.data)) {
        const by = new Map<string, { inst: number; foreign: number; trust: number }>();
        for (const r of j.data) {
          const e = by.get(r.date) ?? { inst: 0, foreign: 0, trust: 0 };
          const net = r.buy - r.sell;
          e.inst += net;
          if (r.name === "Foreign_Investor") e.foreign += net;
          if (r.name === "Investment_Trust") e.trust += net;
          by.set(r.date, e);
        }
        const rows = [...by.entries()].sort(([a2], [b2]) => a2.localeCompare(b2)).map(([date, v]) => ({ date, ...v }));
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
  const gap = Number(process.env.GAP_MS ?? 12_000);
  for (const s of syms) if (await one(s)) await sleep(gap);
  console.log(`${which} 完成 ${syms.length} 檔`);
})();
