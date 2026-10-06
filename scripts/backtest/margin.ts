/**
 * 融資融券組合判讀回測（2026-10-06）。
 *   npx tsx scripts/backtest/marginFetch.ts is|oos   # 先下載每日融資融券（FinMind，可續傳）
 *   npx tsx scripts/backtest/margin.ts [is|oos|both]
 *
 * 問題：marginSignal.ts 的四種訊號（追高風險／可能軋空／籌碼沉澱／空方佔優）能不能拿來加進「建議買進」的計分？
 * 方法跟 stability.ts 同一套：每個交易日用正式評等核心 computeRatingCore()（採用版：單日籌碼＋2日確認）評等，
 * 每週最後一個交易日的評等 → 隔日開盤進場、10／20 日後收盤，超額＝減同日同市值層級平均，Newey-West t 值。
 * 訊號用當天收盤的漲跌幅＋當天融資融券餘額增減（FinMind，單位張），門檻全部用 marginSignalData.ts 的正式常數（事先定好、不調參）。
 *
 * 事先定好的上線條件（兩段樣本都要成立）：
 *  ① 被排除的那一群（例如建議買進且追高風險）自己的超額 < 0 且方向在樣本內外一致；
 *  ② 排除後的建議買進 10／20 日超額點估計 ≥ 現行、t 值不下降超過 0.3。
 * 達不到就只當資訊顯示、不計分。
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, Chips } from "@/lib/data/types";
import { computeRatingCore } from "@/lib/ai/ratingCore";
import type { ConfirmState } from "@/lib/ai/ratingStability";
import { ACTIVE_CHASE_GUARDS } from "@/lib/ai/chaseGuards";
import { computeMarginSignal } from "@/lib/ai/marginSignal";
import type { MarginSignalCode } from "@/lib/ai/marginSignalData";
import type { RatingCode } from "@/lib/ai/siteRating";
import { weeklySignalDates, type Tier } from "./wideData";
import { IS, OOS, type PeriodConfig } from "./regimeConfig";
import { buildUniverseFor, loadCandlesFor } from "./regimeData";

const HS = [10, 20] as const;
type H = (typeof HS)[number];

interface DayChips { date: string; inst: number; foreign: number; trust: number }
interface MarginRow { date: string; mb: number; mbPrev: number; sb: number; sbPrev: number; mLimit: number; sLimit: number }

function loadRows<T>(p: PeriodConfig, dir: string, sym: string): T[] | null {
  const fn = path.join(p.cacheDir, dir, `${sym}.json`);
  if (!fs.existsSync(fn)) return null;
  const d = JSON.parse(fs.readFileSync(fn, "utf8")) as { rows: T[] };
  return d.rows?.length ? d.rows : null;
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const fwd = (cs: Candle[], i: number, h: number) => (cs[i + 1] && cs[i + h] ? (cs[i + h].close / cs[i + 1].open - 1) * 100 : null);

function nwT(series: number[], h: number): number {
  const T = series.length;
  const mu = mean(series);
  if (T < 4) return NaN;
  const L = Math.ceil(h / 5);
  const dev = series.map((x) => x - mu);
  const gamma = (l: number) => dev.slice(l).reduce((a, x, k) => a + x * dev[k], 0) / T;
  let v = gamma(0);
  for (let l = 1; l <= L; l++) v += 2 * (1 - l / (L + 1)) * gamma(l);
  return v > 0 ? mu / Math.sqrt(v / T) : NaN;
}

interface Obs {
  sym: string;
  tier: Tier;
  date: string;
  code: RatingCode;
  sig: MarginSignalCode | null;
  ret: Record<H, number | null>;
}

const SIGS: Array<[MarginSignalCode | "none", string]> = [
  ["chase", "追高風險"], ["squeeze", "可能軋空"], ["settle", "籌碼沉澱"], ["bearish", "空方佔優"], ["neutral", "中性"], ["none", "無融資融券資料"],
];

function run(p: PeriodConfig) {
  const { universe } = buildUniverseFor(p);
  const cal = loadCandlesFor(p, "2330")!.map((c) => c.time).filter((d) => d >= p.signalStart && d <= p.signalEnd);
  const weekly = new Set(weeklySignalDates(cal, p.signalStart, p.signalEnd));
  const twii = loadCandlesFor(p, "_TWII");
  const ret60 = new Map<string, number>();
  if (twii) twii.forEach((c, k) => k >= 60 && ret60.set(c.time, (c.close / twii[k - 60].close - 1) * 100));
  const obs: Obs[] = [];
  let used = 0;
  for (const u of universe) {
    const cs = loadCandlesFor(p, u.sym);
    const dc = loadRows<DayChips>(p, "daily-chips", u.sym);
    const mg = loadRows<MarginRow>(p, "daily-margin", u.sym);
    if (!cs || !dc || !mg) continue;
    used++;
    const cIdx = new Map(cs.map((c, i) => [c.time, i]));
    const chipDates = dc.map((r) => r.date);
    const mByDate = new Map(mg.map((r) => [r.date, r]));
    let j = -1;
    let state: ConfirmState | null = null;
    for (const date of cal) {
      const i = cIdx.get(date);
      if (i == null || i < 63 || !cs[i + 1] || cs[i].volume === 0) continue;
      while (j + 1 < chipDates.length && chipDates[j + 1] <= date) j++;
      const hasToday = j >= 0 && chipDates[j] === date;
      const hist = cs.slice(0, i + 1);
      const win = hist.slice(-63);
      const chips: Chips | null = hasToday
        ? { institutionalNetShares: dc[j].inst, foreignNetShares: dc[j].foreign, trustNetShares: dc[j].trust }
        : null;
      const core = computeRatingCore({
        symbol: u.sym, name: u.name, price: cs[i].close, market: "TW", candles: win, chaseCandles: hist, asOfDay: date, chips,
        guards: ACTIVE_CHASE_GUARDS, marketRet60Pct: ret60.get(date) ?? null, confirmPrev: state,
      });
      state = core.rating.confirmState ?? null;
      const m = mByDate.get(date);
      const prev = cs[i - 1].close;
      const sig = m
        ? computeMarginSignal({
            changePercent: prev > 0 ? (cs[i].close / prev - 1) * 100 : null,
            marginBalance: m.mb, marginBalanceChange: m.mb - m.mbPrev, shortBalance: m.sb, shortBalanceChange: m.sb - m.sbPrev,
          })?.code ?? null
        : null;
      obs.push({ sym: u.sym, tier: u.tier, date, code: core.rating.code, sig, ret: { 10: fwd(cs, i, 10), 20: fwd(cs, i, 20) } });
    }
  }

  // 同日同層級平均（全部股票的 ret，與評等、訊號無關）
  const tierAvg = new Map<string, number>();
  for (const h of HS) {
    const acc = new Map<string, number[]>();
    for (const r of obs) if (r.ret[h] != null) acc.set(`${r.date}|${r.tier}|${h}`, [...(acc.get(`${r.date}|${r.tier}|${h}`) ?? []), r.ret[h]!]);
    for (const [k, vals] of acc) tierAvg.set(k, mean(vals));
  }
  const xt = (r: Obs, h: H) => (r.ret[h] == null ? null : r.ret[h]! - tierAvg.get(`${r.date}|${r.tier}|${h}`)!);
  const statOf = (sel: Obs[], h: H) => {
    const byDate = new Map<string, number[]>();
    for (const r of sel) {
      const x = xt(r, h);
      if (x != null) byDate.set(r.date, [...(byDate.get(r.date) ?? []), x]);
    }
    const series = [...byDate.keys()].sort().map((d) => mean(byDate.get(d)!));
    return { n: [...byDate.values()].reduce((a, b) => a + b.length, 0), mean: mean(series), t: nwT(series, h) };
  };
  const f = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(2)}` : "—");
  const cell = (sel: Obs[]) => {
    const a = statOf(sel, 10), b = statOf(sel, 20);
    return `${a.n} | ${f(a.mean)}（${f(a.t)}） | ${f(b.mean)}（${f(b.t)}）`;
  };

  const wk = obs.filter((r) => weekly.has(r.date));
  const sigOf = (r: Obs) => r.sig ?? "none";
  console.log(`\n## ${p.label}（${used} 檔、${cal.length} 個交易日、${weekly.size} 週；每週最後交易日取樣）\n`);
  for (const [title, base] of [
    ["全部股票（不分評等）", wk],
    ["建議買進", wk.filter((r) => r.code === "buy")],
    ["先不要買", wk.filter((r) => r.code === "avoid")],
  ] as Array<[string, Obs[]]>) {
    console.log(`### ${title}：依融資融券組合判讀分組\n`);
    console.log("| 訊號 | 筆數 | 10日超額（t） | 20日超額（t） |\n|---|---:|---|---|");
    console.log(`| 全部 | ${cell(base)} |`);
    for (const [k, label] of SIGS) console.log(`| ${label} | ${cell(base.filter((r) => sigOf(r) === k))} |`);
    console.log("");
  }

  // 事先定好的變體（建議買進組）
  const buys = wk.filter((r) => r.code === "buy");
  const avoids = wk.filter((r) => r.code === "avoid");
  const V: Array<[string, Obs[], Obs[]]> = [
    ["現行（建議買進）", buys, []],
    ["V1 建議買進排除「追高風險」", buys.filter((r) => r.sig !== "chase"), buys.filter((r) => r.sig === "chase")],
    ["V2 排除「追高風險」＋「空方佔優」", buys.filter((r) => r.sig !== "chase" && r.sig !== "bearish"), buys.filter((r) => r.sig === "chase" || r.sig === "bearish")],
    ["V3 排除「空方佔優」", buys.filter((r) => r.sig !== "bearish"), buys.filter((r) => r.sig === "bearish")],
    ["V4 現行＋先不要買裡的「籌碼沉澱」升為建議買進", [...buys, ...avoids.filter((r) => r.sig === "settle")], avoids.filter((r) => r.sig === "settle")],
    ["V5 V2＋V4", [...buys.filter((r) => r.sig !== "chase" && r.sig !== "bearish"), ...avoids.filter((r) => r.sig === "settle")], []],
  ];
  console.log("### 變體（建議買進組；被排除／新增的那一群另列）\n");
  console.log("| 變體 | 筆數 | 10日超額（t） | 20日超額（t） | 被排除／新增那群：筆數 | 10日 | 20日 |\n|---|---:|---|---|---:|---|---|");
  for (const [name, sel, removed] of V) {
    const a = statOf(removed, 10), b = statOf(removed, 20);
    console.log(`| ${name} | ${cell(sel)} | ${removed.length ? `${a.n} | ${f(a.mean)}（${f(a.t)}） | ${f(b.mean)}（${f(b.t)}）` : "— | — | —"} |`);
  }
  // 日頻的資訊價值（所有股票每天；相鄰日重疊，t 僅供參考）
  console.log("\n### 日頻（全部股票每天、10日超額）：依訊號分組\n");
  console.log("| 訊號 | 筆數 | 10日超額 |\n|---|---:|---|");
  for (const [k, label] of SIGS) {
    const sel = obs.filter((r) => sigOf(r) === k);
    const xs = sel.map((r) => xt(r, 10)).filter((x): x is number => x != null);
    console.log(`| ${label} | ${xs.length} | ${f(mean(xs))} |`);
  }
}

const which = process.argv[2] ?? "is";
if (which === "is" || which === "both") run(IS);
if (which === "oos" || which === "both") run(OOS);
