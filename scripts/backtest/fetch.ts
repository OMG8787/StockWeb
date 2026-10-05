/**
 * 回測資料下載（只補本機快取沒有的）：
 *   npx tsx scripts/backtest/fetch.ts
 *
 * - 日K：正式站 /api/chart/{代號}?range=6m&market=TW（帶 site_unlocked cookie）。
 * - 三大法人：證交所 T86（每個訊號日一份）。
 * 證交所對連續請求會限流（428/503，曾擋 30 分鐘以上）：一律循序、每筆間隔 3 秒，失敗就停，不重試轟炸。
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, CHART_RANGE, SIGNAL_DATES, SITE, UNIVERSE } from "./config";

const GAP_MS = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function main() {
  const chartDir = path.join(CACHE_DIR, "charts");
  const t86Dir = path.join(CACHE_DIR, "t86");
  fs.mkdirSync(chartDir, { recursive: true });
  fs.mkdirSync(t86Dir, { recursive: true });

  for (const sym of UNIVERSE) {
    const fn = path.join(chartDir, `${sym}.json`);
    if (fs.existsSync(fn)) continue;
    const data = await getJson(`${SITE}/api/chart/${sym}?range=${CHART_RANGE}&market=TW`, { Cookie: "site_unlocked=granted" });
    fs.writeFileSync(fn, JSON.stringify(data));
    console.log(`日K ${sym} OK`);
    await sleep(GAP_MS);
  }
  for (const d of SIGNAL_DATES) {
    const ymd = d.replace(/-/g, "");
    const fn = path.join(t86Dir, `${ymd}.json`);
    if (fs.existsSync(fn)) continue;
    const data = (await getJson(
      `https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd}&selectType=ALLBUT0999&response=json`
    )) as { stat?: string };
    if (data.stat !== "OK") throw new Error(`T86 ${ymd} stat=${data.stat}`);
    fs.writeFileSync(fn, JSON.stringify(data));
    console.log(`T86 ${ymd} OK`);
    await sleep(GAP_MS);
  }
  console.log(`完成；快取在 ${CACHE_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
