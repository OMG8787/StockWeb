/**
 * 擴大樣本回測的資料下載（可續傳：已存在的檔一律跳過，中斷後重跑即可）：
 *   npx tsx scripts/backtest/wideFetch.ts
 *
 * 來源全部免費、免金鑰：證交所 MI_INDEX／T86、櫃買 dailyQuotes／insti dailyTrade、
 * Yahoo chart API、公開資訊觀測站月營收彙總表。
 * 一律循序、每筆間隔數秒，失敗退避（60s、120s、180s）後仍失敗就停（證交所曾擋本機 IP 30 分鐘以上）。
 */
import fs from "node:fs";
import path from "node:path";
import {
  CHART_FROM, CHART_TO, INDEX_SYMBOL, MARKET_ETF, SELECTION_DATES, SIGNAL_END, SIGNAL_START, WIDE_CACHE_DIR,
} from "./wideConfig";
import { buildUniverse, loadCandles, weeklySignalDates, type UniverseEntry } from "./wideData";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

async function fetchWithBackoff(url: string, label: string): Promise<Response> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (res.ok) return res;
      if (res.status === 404) return res;
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

async function fetchSelection() {
  const dir = path.join(WIDE_CACHE_DIR, "selection");
  fs.mkdirSync(dir, { recursive: true });
  for (const d of SELECTION_DATES) {
    await saveJson(
      `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd(d)}&type=ALLBUT0999&response=json`,
      path.join(dir, `twse_${ymd(d)}.json`), `上市行情 ${d}`, 3500,
      (x) => (x as { stat?: string }).stat === "OK"
    );
    await saveJson(
      `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${slash(d)}&id=&response=json`,
      path.join(dir, `tpex_${ymd(d)}.json`), `上櫃行情 ${d}`, 3500,
      (x) => ((x as { tables?: Array<{ data?: unknown[] }> }).tables?.[0]?.data?.length ?? 0) > 0
    );
  }
}

const toUnix = (d: string) => Math.floor(Date.parse(`${d}T00:00:00+08:00`) / 1000);

interface YahooChart {
  chart: {
    result?: Array<{
      timestamp?: number[];
      indicators: {
        quote: Array<{ open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }>;
        adjclose?: Array<{ adjclose: (number | null)[] }>;
      };
    }>;
    error?: unknown;
  };
}

/** 抓 Yahoo 日K → 還原權息後的 Candle[]（存成 {candles}）。抓不到回傳 false。 */
async function fetchYahoo(ysym: string, fn: string): Promise<boolean> {
  if (fs.existsSync(fn)) return true;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?period1=${toUnix(CHART_FROM)}&period2=${toUnix(CHART_TO)}&interval=1d&events=div%2Csplit`;
  const res = await fetchWithBackoff(url, `Yahoo ${ysym}`);
  await sleep(1200);
  if (!res.ok) return false;
  const j = (await res.json()) as YahooChart;
  const r = j.chart.result?.[0];
  if (!r?.timestamp?.length) return false;
  const q = r.indicators.quote[0];
  const adj = r.indicators.adjclose?.[0]?.adjclose;
  const candles = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const [o, h, l, c, v] = [q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]];
    if (o == null || h == null || l == null || c == null || !(c > 0)) continue;
    const f = adj?.[i] != null && c > 0 ? adj[i]! / c : 1;
    const time = new Date((r.timestamp[i] + 8 * 3600) * 1000).toISOString().slice(0, 10);
    candles.push({ time, open: o * f, high: h * f, low: l * f, close: c * f, volume: v ?? 0 });
  }
  // Yahoo 偶爾同一天重複兩根：保留最後一根
  const byDay = new Map(candles.map((c) => [c.time, c]));
  fs.writeFileSync(fn, JSON.stringify({ symbol: ysym, candles: [...byDay.values()] }));
  console.log(`Yahoo ${ysym} OK（${byDay.size} 根）`);
  return true;
}

async function fetchCharts(universe: UniverseEntry[]) {
  const dir = path.join(WIDE_CACHE_DIR, "charts");
  fs.mkdirSync(dir, { recursive: true });
  const failed: string[] = [];
  for (const u of universe) {
    const fn = path.join(dir, `${u.sym}.json`);
    const primary = u.market === "TWSE" ? `${u.sym}.TW` : `${u.sym}.TWO`;
    const alt = u.market === "TWSE" ? `${u.sym}.TWO` : `${u.sym}.TW`; // 期間內轉上市／下櫃的
    if (!(await fetchYahoo(primary, fn)) && !(await fetchYahoo(alt, fn))) failed.push(u.sym);
  }
  for (const [ysym, name] of [[INDEX_SYMBOL, "_TWII"], [MARKET_ETF, "_0050"]]) await fetchYahoo(ysym, path.join(dir, `${name}.json`));
  fs.writeFileSync(path.join(WIDE_CACHE_DIR, "charts_failed.json"), JSON.stringify(failed));
  console.log(`日K完成；抓不到 ${failed.length} 檔：${failed.join(" ")}`);
}

async function fetchChips(dates: string[]) {
  const dir = path.join(WIDE_CACHE_DIR, "chips");
  fs.mkdirSync(dir, { recursive: true });
  for (const d of dates) {
    await saveJson(
      `https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd(d)}&selectType=ALLBUT0999&response=json`,
      path.join(dir, `twse_${ymd(d)}.json`), `T86 ${d}`, 3500,
      (x) => (x as { stat?: string }).stat === "OK"
    );
    await saveJson(
      `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${slash(d)}&id=&response=json`,
      path.join(dir, `tpex_${ymd(d)}.json`), `櫃買法人 ${d}`, 3500,
      (x) => ((x as { tables?: Array<{ data?: unknown[] }> }).tables?.[0]?.data?.length ?? 0) > 0
    );
  }
}

/** 月營收：民國 113/8～115/8，上市（sii）＋上櫃（otc）。 */
async function fetchRevenue() {
  const dir = path.join(WIDE_CACHE_DIR, "revenue");
  fs.mkdirSync(dir, { recursive: true });
  for (let y = 113, m = 8; y < 115 || (y === 115 && m <= 8); m === 12 ? (y++, (m = 1)) : m++) {
    for (const mk of ["sii", "otc"]) {
      const fn = path.join(dir, `${mk}_${y}_${m}.html`);
      if (fs.existsSync(fn)) continue;
      const res = await fetchWithBackoff(`https://mopsov.twse.com.tw/nas/t21/${mk}/t21sc03_${y}_${m}_0.html`, `月營收 ${mk} ${y}/${m}`);
      if (res.ok) {
        fs.writeFileSync(fn, Buffer.from(await res.arrayBuffer()));
        console.log(`月營收 ${mk} ${y}/${m} OK`);
      } else console.warn(`月營收 ${mk} ${y}/${m} HTTP ${res.status}`);
      await sleep(3000);
    }
  }
}

async function main() {
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
  fs.mkdirSync(WIDE_CACHE_DIR, { recursive: true });
  if (!only || only === "selection") await fetchSelection();
  const universe = buildUniverse();
  console.log(`股票池 ${universe.length} 檔（大 ${universe.filter((u) => u.tier === "大型").length}／中 ${universe.filter((u) => u.tier === "中型").length}／小 ${universe.filter((u) => u.tier === "小型").length}）`);
  if (!only || only === "charts") await fetchCharts(universe);
  if (!only || only === "revenue") await fetchRevenue();
  if (!only || only === "chips") {
    const cal = loadCandles("2330")!.map((c) => c.time);
    const dates = weeklySignalDates(cal, SIGNAL_START, SIGNAL_END);
    console.log(`訊號日 ${dates.length} 天（${dates[0]}～${dates.at(-1)}）`);
    await fetchChips(dates);
  }
  console.log(`完成；快取在 ${WIDE_CACHE_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
