/**
 * 策略搜尋（2026-10-16 使用者：「讓 AI 推斷策略，順便讓他用各種策略去操作，然後比對歷史資料來驗證策略正確性……我想先看第一版策略，到底要用哪些指標」）。
 *
 *   npx tsx scripts/strategy-search/run.ts            # 抓資料（有快取就跳過）＋搜尋＋輸出報告
 *
 * 做法（程式搜尋、不是 AI 猜）：
 *  1. 股票池：上市＋上櫃普通股（排除 ETF／存託憑證），依最近一日成交值排名：大型 1～60 全取、中型 61～300 抽 70、小型 301～900 抽 70（固定種子）。
 *     ⚠ 倖存者偏差：用「現在」的名單回看過去（下市的不在內），所以一律跟「同一批股票等權重買進持有」比，不只跟 0050 比。
 *  2. 日K：Yahoo 5 年（跟正式站策略回測同一來源 lib/strategy/backtestData 的抓法：.TW／.TWO，分割調整、不含股息）。
 *  3. 候選策略＝進場訊號 × 趨勢過濾（0～2 個）× 出場條件 × 風控。每個條件都用正式站的 evaluateIndicator（同一份指標程式），
 *     而且只看「截到那天的最近 250 根日K」（跟正式站 1 年日K的判斷視窗一致），不偷看未來。
 *  4. 模擬：收盤判斷、隔日開盤成交，用正式站的 runSimDay（同一套停損停利、手續費、證交稅），每檔 10%、最多 10 檔。
 *  5. 驗證：訓練期 2023-10-16～2025-10-15 挑出前幾名，再看它們在「沒看過」的測試期 2025-10-16～2026-10-15 表現。
 *     排名用「報酬 ÷ 最大回撤」（Calmar），交易次數太少的不列入。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Candle } from "@/lib/data/types";
import { evaluateIndicator } from "@/lib/strategy/indicatorCatalog";
import { DEFAULT_STRATEGY_CONFIG, runSimDay, type Candidate, type SimState, type StrategyConfig } from "@/lib/strategy/engine";
import { STRATEGY_TEMPLATES } from "@/lib/strategy/templates";

const CACHE = process.env.STRATEGY_SEARCH_CACHE ?? path.join(os.tmpdir(), "stockweb-strategy-search");
const OUT = path.join(process.cwd(), "docs", "backtest", "2026-10-strategy-search.md");
const TRAIN: [string, string] = ["2023-10-16", "2025-10-15"];
const TEST: [string, string] = ["2025-10-16", "2026-10-15"];
const WINDOW = 250;
const INITIAL = 1_000_000;
const MIN_TRAIN_TRADES = 40;
const SEED = 20261016;

// ---------- 候選條件（參數都照正式站的參考指標類型） ----------
type Cond = { key: string; label: string; typeId: string; params: Record<string, number | string> };
const ENTRIES: Cond[] = [
  { key: "macdG", label: "MACD 黃金交叉（3 天內）", typeId: "macd_cross", params: { dir: "golden", within: 3 } },
  { key: "kdG", label: "KD 黃金交叉（3 天內）", typeId: "kd_cross", params: { dir: "golden", within: 3, kLimit: 0 } },
  { key: "kdLow", label: "KD 低檔黃金交叉（K<20）", typeId: "kd_cross", params: { dir: "golden", within: 3, kLimit: 20 } },
  { key: "rsiUp", label: "RSI 由下往上穿越 30（5 天內）", typeId: "rsi_cross", params: { period: 14, dir: "up", level: 30, within: 5 } },
  { key: "ma520G", label: "5 日線黃金交叉 20 日線（3 天內）", typeId: "ma_cross", params: { short: 5, long: 20, dir: "golden", within: 3 } },
  { key: "brk20", label: "突破 20 日新高", typeId: "breakout", params: { days: 20, dir: "high" } },
  { key: "brk60", label: "突破 60 日新高", typeId: "breakout", params: { days: 60, dir: "high" } },
  { key: "align", label: "均線多頭排列（5>20>60、20 日線向上）", typeId: "ma_alignment", params: { short: 5, mid: 20, long: 60, slopeDays: 3 } },
];
const FILTERS: Cond[] = [
  { key: "ma20", label: "收盤在 20 日線之上", typeId: "price_vs_ma", params: { period: 20, op: "gt" } },
  { key: "ma60", label: "收盤在 60 日線之上", typeId: "price_vs_ma", params: { period: 60, op: "gt" } },
  { key: "rsi70", label: "RSI(14) 低於 70（不過熱）", typeId: "rsi", params: { period: 14, op: "lt", value: 70 } },
  { key: "chg15", label: "5 日漲幅低於 15%（不追高）", typeId: "price_change", params: { days: 5, op: "lt", pct: 15 } },
  { key: "vol15", label: "成交量 ≥ 20 日均量 1.5 倍", typeId: "volume_surge", params: { period: 20, multiple: 1.5 } },
];
const EXITS: Cond[] = [
  { key: "xMa20", label: "收盤跌破 20 日線", typeId: "price_vs_ma", params: { period: 20, op: "lt" } },
  { key: "xMa10", label: "收盤跌破 10 日線", typeId: "price_vs_ma", params: { period: 10, op: "lt" } },
  { key: "xMacd", label: "MACD 死亡交叉", typeId: "macd_cross", params: { dir: "dead", within: 1 } },
  { key: "xMa60", label: "收盤跌破 60 日線", typeId: "price_vs_ma", params: { period: 60, op: "lt" } },
];
const RISKS = [
  { key: "r1", label: "停損 8%、停利 20%", stopLossPct: 8, takeProfitPct: 20, maxHoldDays: 0 },
  { key: "r2", label: "停損 8%、不設停利", stopLossPct: 8, takeProfitPct: 0, maxHoldDays: 0 },
  { key: "r3", label: "停損 6%、停利 15%、最多持有 30 天", stopLossPct: 6, takeProfitPct: 15, maxHoldDays: 30 },
];

// ---------- 小工具 ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const num = (v: string | undefined) => Number(String(v ?? "").replace(/,/g, "")) || 0;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// ---------- 1. 股票池 ----------
interface Stock {
  symbol: string;
  name: string;
  yahoo: string;
  tier: "大型" | "中型" | "小型";
}
async function universe(): Promise<Stock[]> {
  const fn = path.join(CACHE, "universe.json");
  if (fs.existsSync(fn)) return JSON.parse(fs.readFileSync(fn, "utf8"));
  const twse = (await getJson("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL")) as Array<{ Code: string; Name: string; TradeValue: string }>;
  await sleep(2000);
  const tpex = (await getJson("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes")) as Array<{ SecuritiesCompanyCode: string; CompanyName: string; TransactionAmount: string }>;
  const ok = (code: string) => /^[1-9]\d{3}$/.test(code) && !code.startsWith("91");
  const all = [
    ...twse.filter((r) => ok(r.Code)).map((r) => ({ symbol: r.Code, name: r.Name, yahoo: `${r.Code}.TW`, value: num(r.TradeValue) })),
    ...tpex.filter((r) => ok(r.SecuritiesCompanyCode)).map((r) => ({ symbol: r.SecuritiesCompanyCode, name: r.CompanyName, yahoo: `${r.SecuritiesCompanyCode}.TWO`, value: num(r.TransactionAmount) })),
  ]
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value);
  const rand = rng(SEED);
  const pick = <T,>(arr: T[], n: number) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, n);
  };
  const out: Stock[] = [
    ...all.slice(0, 60).map((x) => ({ ...x, tier: "大型" as const })),
    ...pick(all.slice(60, 300), 70).map((x) => ({ ...x, tier: "中型" as const })),
    ...pick(all.slice(300, 900), 70).map((x) => ({ ...x, tier: "小型" as const })),
  ].map(({ symbol, name, yahoo, tier }) => ({ symbol, name, yahoo, tier }));
  fs.writeFileSync(fn, JSON.stringify(out));
  return out;
}

// ---------- 2. 日K（Yahoo 5 年，快取） ----------
async function candles(yahoo: string): Promise<Candle[] | null> {
  const fn = path.join(CACHE, "charts", `${yahoo}.json`);
  if (fs.existsSync(fn)) return JSON.parse(fs.readFileSync(fn, "utf8"));
  try {
    const data = (await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}?range=5y&interval=1d`)) as {
      chart: { result?: Array<{ timestamp?: number[]; indicators: { quote: Array<{ open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }> } }> };
    };
    const r = data.chart.result?.[0];
    if (!r?.timestamp) return null;
    const q = r.indicators.quote[0];
    const out: Candle[] = [];
    r.timestamp.forEach((t, i) => {
      const [o, h, l, c] = [q.open[i], q.high[i], q.low[i], q.close[i]];
      if (o == null || h == null || l == null || c == null || c <= 0) return;
      out.push({ time: new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 10), open: o, high: h, low: l, close: c, volume: q.volume[i] ?? 0 });
    });
    fs.writeFileSync(fn, JSON.stringify(out));
    return out;
  } catch {
    return null;
  }
}

// ---------- 3. 預先算好每檔每天每個條件成不成立 ----------
interface Prepared {
  s: Stock;
  c: Candle[];
  idx: Map<string, number>;
  /** 條件 key → 每根K棒成立與否（1 成立、0 不成立或資料不足） */
  sig: Map<string, Uint8Array>;
}
function prepare(s: Stock, c: Candle[], conds: Cond[], from: string): Prepared {
  const sig = new Map<string, Uint8Array>();
  const start = Math.max(0, c.findIndex((x) => x.time >= from) - 1);
  for (const k of conds) {
    const arr = new Uint8Array(c.length);
    for (let i = start; i < c.length; i++) {
      const ctx = { symbol: s.symbol, market: "TW" as const, candles: c.slice(Math.max(0, i - WINDOW + 1), i + 1) };
      arr[i] = evaluateIndicator(k.typeId, k.params, ctx).pass === true ? 1 : 0;
    }
    sig.set(k.key, arr);
  }
  return { s, c, idx: new Map(c.map((x, i) => [x.time, i])), sig };
}

// ---------- 4. 模擬一個策略 ----------
interface Combo {
  id: string;
  /** 顯示用說明 */
  label: string;
  buyKeys: string[];
  /** 0＝全部符合；N＝至少 N 個 */
  buyMatch: number;
  sellKeys: string[];
  risk: { stopLossPct: number; takeProfitPct: number; maxHoldDays: number };
  /** 過濾條件數（同結果時保留最簡單的） */
  size: number;
}
interface Result {
  ret: number;
  maxDd: number;
  calmar: number;
  trades: number;
  winRate: number | null;
  exposure: number;
}
/** site＝跟正式站一樣（成立條件數、同分依代號）；liquidity＝同分時成交值大的優先（對照用） */
type RankMode = "site" | "liquidity";
let RANK: RankMode = "site";
function simulate(combo: Combo, data: Prepared[], calendar: string[], liq: Map<string, number>): Result {
  const cfg: StrategyConfig = { ...DEFAULT_STRATEGY_CONFIG, positionPct: 10, maxPositions: 10, ...combo.risk };
  const need = combo.buyMatch <= 0 ? combo.buyKeys.length : Math.min(combo.buyMatch, combo.buyKeys.length);
  let state: SimState = { initialCash: INITIAL, cash: INITIAL, positions: [] };
  const last = new Map<string, number>();
  let peak = INITIAL;
  let maxDd = 0;
  let sells = 0;
  let wins = 0;
  let investedDays = 0;
  for (let t = 0; t < calendar.length; t++) {
    const day = calendar[t];
    if (t > 0) {
      const prev = calendar[t - 1];
      const held = new Map<string, Candidate>();
      const cands: Candidate[] = [];
      const heldSet = new Set(state.positions.map((p) => p.symbol));
      for (const d of data) {
        const pi = d.idx.get(prev);
        const ti = d.idx.get(day);
        if (pi == null || ti == null) continue;
        const isHeld = heldSet.has(d.s.symbol);
        let hit = 0;
        for (const k of combo.buyKeys) if (d.sig.get(k)![pi] === 1) hit++;
        const buy = hit >= need;
        const sell = combo.sellKeys.some((k) => d.sig.get(k)![pi] === 1);
        if (!isHeld && !buy) continue;
        const cand: Candidate = {
          symbol: d.s.symbol,
          market: "TW",
          name: d.s.name,
          price: d.c[ti].open,
          decision: { buy, sell, score: RANK === "liquidity" ? (liq.get(d.s.symbol) ?? 0) : hit, hits: [], summary: buy ? "買進" : "", sellSummary: "賣出" },
        };
        if (isHeld) held.set(`TW:${d.s.symbol}`, cand);
        if (buy) cands.push(cand);
      }
      const r = runSimDay(state, cfg, day, held, cands);
      state = r.state;
      for (const tr of r.trades) {
        if (tr.side === "sell") {
          sells++;
          if ((tr.pnl ?? 0) > 0) wins++;
        }
      }
    }
    for (const d of data) {
      const i = d.idx.get(day);
      if (i != null) last.set(d.s.symbol, d.c[i].close);
    }
    const equity = state.cash + state.positions.reduce((a, p) => a + p.shares * (last.get(p.symbol) ?? p.avgCost), 0);
    if (state.positions.length) investedDays++;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, (equity / peak - 1) * 100);
    if (t === calendar.length - 1) {
      const ret = (equity / INITIAL - 1) * 100;
      return { ret, maxDd, calmar: maxDd < 0 ? ret / Math.abs(maxDd) : ret, trades: sells, winRate: sells ? (wins / sells) * 100 : null, exposure: (investedDays / calendar.length) * 100 };
    }
  }
  return { ret: 0, maxDd: 0, calmar: 0, trades: 0, winRate: null, exposure: 0 };
}

/** 同一批股票等權重買進持有的報酬與最大回撤（每檔期初開盤等額買進、之後不調整） */
function equalWeightStats(data: Prepared[], from: string, to: string): { ret: number; maxDd: number } {
  const series = data
    .map((d) => {
      const a = d.c.find((x) => x.time >= from);
      return a ? { d, base: a.open } : null;
    })
    .filter((x): x is { d: Prepared; base: number } => !!x);
  const days = [...new Set(series.flatMap((x) => x.d.c.map((c) => c.time)))].filter((t) => t >= from && t <= to).sort();
  const last = new Map<string, number>();
  let peak = -Infinity;
  let maxDd = 0;
  let v = 1;
  for (const day of days) {
    let sum = 0;
    for (const x of series) {
      const i = x.d.idx.get(day);
      if (i != null) last.set(x.d.s.symbol, x.d.c[i].close / x.base);
      sum += last.get(x.d.s.symbol) ?? 1;
    }
    v = sum / Math.max(1, series.length);
    peak = Math.max(peak, v);
    maxDd = Math.min(maxDd, (v / peak - 1) * 100);
  }
  return { ret: (v - 1) * 100, maxDd };
}

/** 同一批股票等權重買進持有（期初開盤買、期末收盤算）——倖存者偏差的對照組 */
function equalWeightHold(data: Prepared[], from: string, to: string): number {
  const rets: number[] = [];
  for (const d of data) {
    const a = d.c.find((x) => x.time >= from);
    const b = [...d.c].reverse().find((x) => x.time <= to);
    if (a && b && b.time > a.time) rets.push((b.close / a.open - 1) * 100);
  }
  return rets.reduce((x, y) => x + y, 0) / Math.max(1, rets.length);
}

// ---------- 主程式 ----------
async function main() {
  fs.mkdirSync(path.join(CACHE, "charts"), { recursive: true });
  const stocks = await universe();
  console.log(`股票池 ${stocks.length} 檔（快取 ${CACHE}）`);
  const loaded: Array<{ s: Stock; c: Candle[] }> = [];
  for (const s of stocks) {
    const had = fs.existsSync(path.join(CACHE, "charts", `${s.yahoo}.json`));
    const c = await candles(s.yahoo);
    if (!had) await sleep(400);
    if (c && c.length > 300) loaded.push({ s, c });
  }
  const bench = await candles("0050.TW");
  console.log(`有日K的 ${loaded.length} 檔`);
  // 本站現有的策略範本（只用日K的那幾個）也用同一套條件與模擬比較
  const templates = STRATEGY_TEMPLATES.filter((t) => t.backtestable);
  const tplConds: Cond[] = templates.flatMap((t) => t.indicators.map((i) => ({ key: `${t.id}:${i.key}`, label: i.key, typeId: i.typeId, params: i.params })));
  const conds = [...ENTRIES, ...FILTERS, ...EXITS, ...tplConds];
  const t0 = Date.now();
  const data = loaded.map(({ s, c }) => prepare(s, c, conds, TRAIN[0]));
  console.log(`預算條件完成 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  const liq = new Map(stocks.map((s, i) => [s.symbol, stocks.length - i]));
  const cal = (from: string, to: string) => [...new Set(data.flatMap((d) => d.c.map((x) => x.time)))].filter((d) => d >= from && d <= to).sort();
  const trainCal = cal(...TRAIN);
  const testCal = cal(...TEST);

  // 組合：進場 × 過濾（0～2 個）× 出場 × 風控
  const filterSets: Cond[][] = [[]];
  FILTERS.forEach((f, i) => {
    filterSets.push([f]);
    FILTERS.slice(i + 1).forEach((g) => filterSets.push([f, g]));
  });
  const combos: Combo[] = [];
  for (const entry of ENTRIES)
    for (const filters of filterSets)
      for (const exit of EXITS)
        for (const risk of RISKS)
          combos.push({
            id: [entry.key, ...filters.map((f) => f.key), exit.key, risk.key].join("+"),
            label: `進場：${entry.label}${filters.length ? `＋${filters.map((f) => f.label).join("＋")}` : ""}；出場：${exit.label}；${risk.label}`,
            buyKeys: [entry.key, ...filters.map((f) => f.key)],
            buyMatch: 0,
            sellKeys: [exit.key],
            risk: { stopLossPct: risk.stopLossPct, takeProfitPct: risk.takeProfitPct, maxHoldDays: risk.maxHoldDays },
            size: filters.length,
          });
  console.log(`候選策略 ${combos.length} 個，開始模擬訓練期…`);
  const t1 = Date.now();
  const train = combos.map((c) => ({ c, r: simulate(c, data, trainCal, liq) }));
  console.log(`訓練期模擬完成 ${((Date.now() - t1) / 1000).toFixed(0)} 秒`);

  // 結果完全相同的組合（例如「突破 20 日新高」已經隱含「收盤在 20 日線之上」）只留條件最少的那個
  const seen = new Map<string, (typeof train)[number]>();
  for (const x of train) {
    const sig = `${x.r.ret.toFixed(4)}|${x.r.maxDd.toFixed(4)}|${x.r.trades}`;
    const had = seen.get(sig);
    if (!had || x.c.size < had.c.size) seen.set(sig, x);
  }
  const unique = [...seen.values()];
  const ranked = unique.filter((x) => x.r.trades >= MIN_TRAIN_TRADES).sort((a, b) => b.r.calmar - a.r.calmar);
  const top = ranked.slice(0, 15).map((x) => ({ ...x, test: simulate(x.c, data, testCal, liq) }));
  // 第一版：前 15 名裡，測試期也贏同批股票等權重持有、且回撤較小的，取測試期 Calmar 最高
  const ewTrain = equalWeightHold(data, ...TRAIN);
  const ewTest = equalWeightHold(data, ...TEST);
  const ewTrainDd = equalWeightStats(data, ...TRAIN).maxDd;
  const ewTestDd = equalWeightStats(data, ...TEST).maxDd;
  const benchRet = (from: string, to: string) => {
    if (!bench) return null;
    const a = bench.find((x) => x.time >= from);
    const b = [...bench].reverse().find((x) => x.time <= to);
    return a && b ? (b.close / a.open - 1) * 100 : null;
  };
  const b0050Train = benchRet(...TRAIN);
  const b0050Test = benchRet(...TEST);

  // 單一條件的貢獻：每個進場／過濾／出場在所有組合裡的平均訓練 Calmar（看哪些指標真的有用）
  const avgBy = (pred: (c: Combo) => boolean) => {
    // 只看格點組合（範本另外列）
    const xs = train.filter((x) => pred(x.c) && x.r.trades >= MIN_TRAIN_TRADES).map((x) => x.r.calmar);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  };

  const f1 = (v: number | null) => (v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
  const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : "—");
  const desc = (c: Combo) => c.label;
  const lines: string[] = [];
  lines.push("# 策略搜尋報告（第一版策略）", "");
  lines.push(`產生：${new Date().toISOString()}｜股票池 ${data.length} 檔（大型／中型／小型分層抽樣、排除 ETF）｜候選策略 ${combos.length} 個`, "");
  lines.push(`訓練期 ${TRAIN[0]}～${TRAIN[1]}（${trainCal.length} 個交易日）、測試期 ${TEST[0]}～${TEST[1]}（${testCal.length} 個交易日，挑選時完全沒看）。`, "");
  lines.push(`對照：同一批股票等權重買進持有 訓練期 ${f1(ewTrain)}（最大回撤 ${f1(ewTrainDd)}）、測試期 ${f1(ewTest)}（最大回撤 ${f1(ewTestDd)}）；0050 訓練期 ${f1(b0050Train)}、測試期 ${f1(b0050Test)}（價格報酬、不含股息）。`, "");
  lines.push("同一天有比空位多的股票出現買進訊號時，照正式站的規則挑（成立的買進條件數多的優先、同分依代號），跟網站上的模擬倉、策略回測一致。", "");
  lines.push("規則：收盤判斷、隔日開盤成交、手續費與證交稅照實扣；每檔 10%、最多 10 檔；條件只看截到當天的最近 250 根日K（同正式站）。排名＝報酬÷最大回撤（Calmar），訓練期交易少於 40 筆的不列入。", "");
  lines.push("## 訓練期前 15 名，與它們在測試期的表現", "");
  lines.push("| # | 策略 | 訓練 報酬 | 訓練 回撤 | 訓練 Calmar | 交易 | 勝率 | 測試 報酬 | 測試 回撤 | 測試 Calmar | 測試 勝率 |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  top.forEach((x, i) =>
    lines.push(
      `| ${i + 1} | ${desc(x.c)} | ${f1(x.r.ret)} | ${f1(x.r.maxDd)} | ${f2(x.r.calmar)} | ${x.r.trades} | ${f1(x.r.winRate)} | ${f1(x.test.ret)} | ${f1(x.test.maxDd)} | ${f2(x.test.calmar)} | ${f1(x.test.winRate)} |`,
    ),
  );
  lines.push("", "## 各條件的平均效果（所有組合的訓練期平均 Calmar，越高越好）", "");
  lines.push("| 類型 | 條件 | 平均 Calmar |", "|---|---|---|");
  for (const e of ENTRIES) lines.push(`| 進場 | ${e.label} | ${f2(avgBy((c) => c.buyKeys[0] === e.key))} |`);
  lines.push(`| 過濾 | （不加過濾） | ${f2(avgBy((c) => c.size === 0))} |`);
  for (const f of FILTERS) lines.push(`| 過濾 | ${f.label} | ${f2(avgBy((c) => c.buyKeys.slice(1).includes(f.key)))} |`);
  for (const x of EXITS) lines.push(`| 出場 | ${x.label} | ${f2(avgBy((c) => c.sellKeys[0] === x.key))} |`);
  for (const r of RISKS) lines.push(`| 風控 | ${r.label} | ${f2(avgBy((c) => c.risk.stopLossPct === r.stopLossPct && c.risk.takeProfitPct === r.takeProfitPct && c.risk.maxHoldDays === r.maxHoldDays))} |`);
  // 第一版＝訓練期第 1 名（只用訓練期挑；測試期只驗證）。穩健版＝訓練期前 15 名裡、訓練期回撤最小且 Calmar 不低於第 1 名 80% 的。
  const first = top[0] ?? null;
  const steady = top.filter((x) => first && x.r.calmar >= first.r.calmar * 0.8).sort((a, b) => b.r.maxDd - a.r.maxDd)[0] ?? null;
  const v1 = first && first.test.calmar > 0 && first.test.ret > ewTest ? first : null;
  lines.push("", "## 第一版策略（只用訓練期挑選，測試期驗證）", "");
  const show = (title: string, x: (typeof top)[number] | null) => {
    if (!x) return;
    lines.push(`**${title}：${desc(x.c)}**`, "");
    lines.push(`- 訓練期：報酬 ${f1(x.r.ret)}（同批等權重 ${f1(ewTrain)}、0050 ${f1(b0050Train)}）、最大回撤 ${f1(x.r.maxDd)}、${x.r.trades} 筆、勝率 ${f1(x.r.winRate)}`);
    lines.push(`- 測試期（沒看過的資料）：報酬 ${f1(x.test.ret)}（同批等權重 ${f1(ewTest)}、0050 ${f1(b0050Test)}）、最大回撤 ${f1(x.test.maxDd)}、${x.test.trades} 筆、勝率 ${f1(x.test.winRate)}`, "");
  };
  if (v1) show("第一版", v1);
  else lines.push("訓練期第 1 名在測試期沒有贏過「同一批股票等權重持有」——不建議上線。", "");
  if (steady && steady !== first) show("穩健版（回撤較小）", steady);

  // 穩健度：第一版分大型／中型／小型各自跑，跟同層的等權重持有比（動能策略最怕倖存者偏差，分層看是不是哪一層都有效）
  if (first) {
    lines.push("### 第一版分層檢查（各層只用該層股票，每檔 10%、最多 10 檔）", "");
    lines.push("| 分層 | 檔數 | 訓練 策略（回撤） | 訓練 同層買進持有（回撤） | 測試 策略（回撤） | 測試 同層買進持有（回撤） |", "|---|---|---|---|---|---|");
    for (const tier of ["大型", "中型", "小型"] as const) {
      const sub = data.filter((d) => d.s.tier === tier);
      const tr = simulate(first.c, sub, trainCal, liq);
      const te = simulate(first.c, sub, testCal, liq);
      const eTr = equalWeightStats(sub, ...TRAIN);
      const eTe = equalWeightStats(sub, ...TEST);
      lines.push(`| ${tier} | ${sub.length} | ${f1(tr.ret)}（${f1(tr.maxDd)}） | ${f1(eTr.ret)}（${f1(eTr.maxDd)}） | ${f1(te.ret)}（${f1(te.maxDd)}） | ${f1(eTe.ret)}（${f1(eTe.maxDd)}） |`);
    }
    lines.push("");
    // 對照：同一個策略，買進名額有限時改成「成交值大的優先」
    RANK = "liquidity";
    const lt = simulate(first.c, data, trainCal, liq);
    const le = simulate(first.c, data, testCal, liq);
    RANK = "site";
    lines.push(`對照：同一個第一版策略，若名額有限時改成「成交值大的優先」，訓練期 ${f1(lt.ret)}（回撤 ${f1(lt.maxDd)}）、測試期 ${f1(le.ret)}（回撤 ${f1(le.maxDd)}）——差多少就代表結果有多少是「偏向大型股」帶來的。`, "");
  }

  // 現有範本同條件比較
  const tplRows = templates.map((t) => {
    const c: Combo = {
      id: `tpl:${t.id}`,
      label: t.name,
      buyKeys: t.buy.keys.map((k) => `${t.id}:${k}`),
      buyMatch: t.buy.match,
      sellKeys: t.sell.keys.map((k) => `${t.id}:${k}`),
      risk: { stopLossPct: t.stopLossPct, takeProfitPct: t.takeProfitPct, maxHoldDays: t.maxHoldDays },
      size: 0,
    };
    return { t, train: simulate(c, data, trainCal, liq), test: simulate(c, data, testCal, liq) };
  });
  lines.push("## 現有策略範本在同樣條件下的表現（每檔 10%、最多 10 檔）", "");
  lines.push("| 範本 | 訓練 報酬 | 訓練 回撤 | 訓練 Calmar | 交易 | 測試 報酬 | 測試 回撤 | 測試 Calmar |", "|---|---|---|---|---|---|---|---|");
  for (const x of tplRows) lines.push(`| ${x.t.name} | ${f1(x.train.ret)} | ${f1(x.train.maxDd)} | ${f2(x.train.calmar)} | ${x.train.trades} | ${f1(x.test.ret)} | ${f1(x.test.maxDd)} | ${f2(x.test.calmar)} |`);
  lines.push("");
  lines.push("", "## 限制", "");
  lines.push("- 倖存者偏差：股票池是現在的名單；所以要跟同批等權重持有比，不能只看絕對報酬。", "- 只用日K類指標：籌碼、基本面、本站評等沒有逐日歷史，這次沒有納入。", "- 不含股息；成交以開盤價、不考慮滑價與漲跌停買不到。", "- 測試期只有一年、單一市況，結果是方向參考，之後要用模擬倉繼續追蹤。");
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join("\n"));
  fs.writeFileSync(
    path.join(CACHE, "result.json"),
    JSON.stringify(
      {
        top: top.map((x) => ({ id: x.c.id, desc: desc(x.c), train: x.r, test: x.test })),
        v1: v1 ? { id: v1.c.id, desc: desc(v1.c), train: v1.r, test: v1.test } : null,
        steady: steady ? { id: steady.c.id, desc: desc(steady.c), train: steady.r, test: steady.test } : null,
        templates: tplRows.map((x) => ({ id: x.t.id, name: x.t.name, train: x.train, test: x.test })),
        ewTrain,
        ewTest,
        b0050Train,
        b0050Test,
      },
      null,
      1,
    ),
  );
  console.log(`完成：${OUT}`);
  console.log(v1 ? `第一版：${desc(v1.c)}` : "沒有可靠的第一版策略");
  if (steady && steady !== first) console.log(`穩健版：${desc(steady.c)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
