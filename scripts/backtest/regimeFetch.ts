/**
 * 市況開關研究：樣本外期間（2022-01～2024-09）資料下載（可續傳，已存在的檔跳過）：
 *   npx tsx scripts/backtest/regimeFetch.ts [--only=selection|charts|chips]
 * 與 wideFetch.ts 同一套來源與節流（循序、間隔、60/120/180s 退避，連續失敗即停）。
 * 不 import wideFetch.ts：它在載入時就會執行 main()。
 */
import fs from "node:fs";
import path from "node:path";
import { OOS } from "./regimeConfig";
import { buildUniverseFor, loadCandlesFor } from "./regimeData";
import { weeklySignalDates } from "./wideData";
import { INDEX_SYMBOL, MARKET_ETF } from "./wideConfig";

const P = OOS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

async function fetchWithBackoff(url: string, label: string): Promise<Response> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: UA });
      // Yahoo 對「該期間沒有資料」回 400（Bad Request: Data doesn't exist），當成查無資料，不退避
      if (res.ok || res.status === 404 || (res.status === 400 && label.startsWith("Yahoo"))) return res;
      console.warn(`${label} HTTP ${res.status}，退避 ${60 * (attempt + 1)}s`);
    } catch (e) {
      console.warn(`${label} 連線錯誤 ${(e as Error).message}，退避 ${60 * (attempt + 1)}s`);
    }
    await sleep(60_000 * (attempt + 1));
  }
  throw new Error(`${label} 連續失敗，停止（避免被擋）`);
}

async function saveJson(url: string, fn: string, label: string, gapMs: number, ok: (d: unknown) => boolean) {
  if (fs.existsSync(fn)) return;
  const res = await fetchWithBackoff(url, label);
  const d = (await res.json()) as unknown;
  if (!ok(d)) {
    console.warn(`${label} 回傳內容不符預期（可能非交易日），寫入空標記`);
    fs.writeFileSync(fn, JSON.stringify({ empty: true, raw: d }));
  } else fs.writeFileSync(fn, JSON.stringify(d));
  console.log(`${label} OK`);
  await sleep(gapMs);
}

const ymd = (d: string) => d.replace(/-/g, "");
const slash = (d: string) => encodeURIComponent(d.replace(/-/g, "/"));
const toUnix = (d: string) => Math.floor(Date.parse(`${d}T00:00:00+08:00`) / 1000);

async function fetchSelection() {
  const dir = path.join(P.cacheDir, "selection");
  fs.mkdirSync(dir, { recursive: true });
  for (const d of P.selectionDates) {
    await saveJson(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd(d)}&type=ALLBUT0999&response=json`,
      path.join(dir, `twse_${ymd(d)}.json`), `上市行情 ${d}`, 3500, (x) => (x as { stat?: string }).stat === "OK");
    await saveJson(`https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${slash(d)}&id=&response=json`,
      path.join(dir, `tpex_${ymd(d)}.json`), `上櫃行情 ${d}`, 3500,
      (x) => ((x as { tables?: Array<{ data?: unknown[] }> }).tables?.[0]?.data?.length ?? 0) > 0);
  }
}

interface YahooChart {
  chart: {
    result?: Array<{
      timestamp?: number[];
      indicators: {
        quote: Array<{ open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }>;
        adjclose?: Array<{ adjclose: (number | null)[] }>;
      };
    }>;
  };
}

async function fetchYahoo(ysym: string, fn: string): Promise<boolean> {
  if (fs.existsSync(fn)) return true;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?period1=${toUnix(P.chartFrom)}&period2=${toUnix(P.chartTo)}&interval=1d&events=div%2Csplit`;
  const res = await fetchWithBackoff(url, `Yahoo ${ysym}`);
  await sleep(1200);
  if (!res.ok) return false;
  const r = ((await res.json()) as YahooChart).chart.result?.[0];
  if (!r?.timestamp?.length) return false;
  const q = r.indicators.quote[0];
  const adj = r.indicators.adjclose?.[0]?.adjclose;
  const candles = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const [o, h, l, c, v] = [q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]];
    if (o == null || h == null || l == null || c == null || !(c > 0)) continue;
    const f = adj?.[i] != null ? adj[i]! / c : 1;
    const time = new Date((r.timestamp[i] + 8 * 3600) * 1000).toISOString().slice(0, 10);
    candles.push({ time, open: o * f, high: h * f, low: l * f, close: c * f, volume: v ?? 0 });
  }
  const byDay = new Map(candles.map((c) => [c.time, c]));
  if (byDay.size < 30) return false;
  fs.writeFileSync(fn, JSON.stringify({ symbol: ysym, candles: [...byDay.values()] }));
  console.log(`Yahoo ${ysym} OK（${byDay.size} 根）`);
  return true;
}

async function fetchCharts() {
  const { universe } = buildUniverseFor(P);
  const dir = path.join(P.cacheDir, "charts");
  fs.mkdirSync(dir, { recursive: true });
  for (const [ysym, name] of [[INDEX_SYMBOL, "_TWII"], [MARKET_ETF, "_0050"]]) await fetchYahoo(ysym, path.join(dir, `${name}.json`));
  const failed: string[] = [];
  for (const u of universe) {
    const fn = path.join(dir, `${u.sym}.json`);
    const primary = u.market === "TWSE" ? `${u.sym}.TW` : `${u.sym}.TWO`;
    const alt = u.market === "TWSE" ? `${u.sym}.TWO` : `${u.sym}.TW`;
    if (!(await fetchYahoo(primary, fn)) && !(await fetchYahoo(alt, fn))) failed.push(`${u.sym} ${u.name}（${u.tier}）`);
  }
  fs.writeFileSync(path.join(P.cacheDir, "charts_failed.json"), JSON.stringify(failed));
  console.log(`日K完成；抓不到 ${failed.length} 檔：${failed.join("、")}`);
}

async function fetchChips() {
  const cal = loadCandlesFor(P, "2330")!.map((c) => c.time);
  const dates = weeklySignalDates(cal, P.signalStart, P.signalEnd);
  console.log(`訊號日 ${dates.length} 天（${dates[0]}～${dates.at(-1)}）`);
  const dir = path.join(P.cacheDir, "chips");
  fs.mkdirSync(dir, { recursive: true });
  for (const d of dates) {
    await saveJson(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd(d)}&selectType=ALLBUT0999&response=json`,
      path.join(dir, `twse_${ymd(d)}.json`), `T86 ${d}`, 3500, (x) => (x as { stat?: string }).stat === "OK");
    await saveJson(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${slash(d)}&id=&response=json`,
      path.join(dir, `tpex_${ymd(d)}.json`), `櫃買法人 ${d}`, 3500,
      (x) => ((x as { tables?: Array<{ data?: unknown[] }> }).tables?.[0]?.data?.length ?? 0) > 0);
  }
}

async function main() {
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
  fs.mkdirSync(P.cacheDir, { recursive: true });
  if (!only || only === "selection") await fetchSelection();
  const { universe, rankedTotal } = buildUniverseFor(P);
  console.log(`選樣期普通股 ${rankedTotal} 檔；股票池 ${universe.length} 檔`);
  if (!only || only === "charts") await fetchCharts();
  if (!only || only === "chips") await fetchChips();
  console.log(`完成；快取在 ${P.cacheDir}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
