/**
 * RSI 算法比較回測（2026-10-07 使用者：「RSI 簡單平均 vs 券商 Wilder——KD 已改券商版，RSI 同理應改 Wilder 版」）。
 *   npx tsx scripts/backtest/rsiFormula.ts [is|oos|both]
 * 資料全用既有快取（K線＋FinMind 每日三大法人，不打證交所）。樣本與 stability.ts 相同（樣本內 198 檔／樣本外 194 檔）。
 *
 * 比較兩種 RSI(14)：
 *   simple  本站舊算法：最近 14 個變動的漲幅總和／跌幅總和（無平滑）
 *   wilder  券商慣用：Wilder 平滑（第一個平均＝前 14 變動簡單平均，之後 avg＝(前avg×13＋今日變動)/14）
 * 事先定好的指標與採用條件（看結果前寫死）：
 *   a. 「RSI≥70（超買）」「RSI≤30（超賣）」當日出現 → 隔日開盤進場、5／10／20 日超額（減同日同層級平均）、勝率、事件數、
 *      每檔每月次數；t＝逐日平均後 Newey-West（落後＝持有日數）。
 *   b. 整體評等（正式評等核心 computeRatingCore，採用版＝單日籌碼＋2日確認）建議買進／先不要買 10／20 日超額與 t
 *      （每週最後交易日取樣，同 stability.ts）、每檔每月翻轉次數；逐週配對差（wilder−simple）的 t。
 *   採用條件：建議買進 10／20 日超額點估計樣本內外都不比舊版低超過 0.15（百分點）、配對差 |t|<2、先不要買維持落後
 *   （20 日超額仍為負）；不符合就先不換、把數字交給使用者決定。門檻 70／30 是業界慣例，Wilder 版不另調（若通過條件就維持 70／30）。
 * 預設行為不變：只用 withRsiMethod() 在回測內暫時切換，正式站不受影響。
 */
import type { Candle, Chips } from "@/lib/data/types";
import { computeRatingCore } from "@/lib/ai/ratingCore";
import type { ConfirmState } from "@/lib/ai/ratingStability";
import { ACTIVE_CHASE_GUARDS } from "@/lib/ai/chaseGuards";
import type { HoldingCode, RatingCode } from "@/lib/ai/siteRating";
import { latestRsi, withRsiMethod, type RsiMethod } from "@/lib/rsiFormula";
import fs from "node:fs";
import path from "node:path";
import { weeklySignalDates, type Tier } from "./wideData";
import { IS, OOS, type PeriodConfig } from "./regimeConfig";
import { buildUniverseFor, loadCandlesFor } from "./regimeData";

const HS = [5, 10, 20] as const;
type H = (typeof HS)[number];
const METHODS: RsiMethod[] = ["simple", "wilder"];
const NAME: Record<RsiMethod, string> = { simple: "簡單平均（舊）", wilder: "Wilder（券商）" };

interface DayChips { date: string; inst: number; foreign: number; trust: number }
function loadDailyChips(p: PeriodConfig, sym: string): DayChips[] | null {
  const fn = path.join(p.cacheDir, "daily-chips", `${sym}.json`);
  if (!fs.existsSync(fn)) return null;
  const d = JSON.parse(fs.readFileSync(fn, "utf8")) as { rows: DayChips[] };
  return d.rows?.length ? d.rows : null;
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const fwd = (cs: Candle[], i: number, h: number) => (cs[i + 1] && cs[i + h] ? (cs[i + h].close / cs[i + 1].open - 1) * 100 : null);
function nwT(series: number[], lag: number): number {
  const T = series.length;
  if (T < 4) return NaN;
  const mu = mean(series);
  const dev = series.map((x) => x - mu);
  const gamma = (l: number) => dev.slice(l).reduce((a, x, k) => a + x * dev[k], 0) / T;
  let v = gamma(0);
  for (let l = 1; l <= lag; l++) v += 2 * (1 - l / (lag + 1)) * gamma(l);
  return v > 0 ? mu / Math.sqrt(v / T) : NaN;
}
const f = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "—");

/** golden＝RSI≤30（超賣）、death＝RSI≥70（超買）；介於其間 null */
type Cross = "golden" | "death" | null;
interface DayRec {
  sym: string; tier: Tier; date: string; idx: number;
  ret: Record<H, number | null>;
  cross: Record<RsiMethod, Cross>;
  rating: Record<RsiMethod, { code: RatingCode; hold: HoldingCode } | null>;
}

const holdClass = (h: HoldingCode) => (h === "add" || h === "hold" ? "keep" : h);

function run(p: PeriodConfig) {
  const { universe } = buildUniverseFor(p);
  const cal = loadCandlesFor(p, "2330")!.map((c) => c.time).filter((d) => d >= p.signalStart && d <= p.signalEnd);
  const weekly = new Set(weeklySignalDates(cal, p.signalStart, p.signalEnd));
  const twii = loadCandlesFor(p, "_TWII");
  const ret60 = new Map<string, number>();
  if (twii) twii.forEach((c, k) => k >= 60 && ret60.set(c.time, (c.close / twii[k - 60].close - 1) * 100));
  const recs: DayRec[] = [];
  let used = 0;
  for (const u of universe) {
    const cs = loadCandlesFor(p, u.sym);
    const dc = loadDailyChips(p, u.sym);
    if (!cs || !dc) continue;
    used++;
    const cIdx = new Map(cs.map((c, i) => [c.time, i]));
    const chipDates = dc.map((r) => r.date);
    let j = -1;
    const states = new Map<RsiMethod, ConfirmState | null>(METHODS.map((m) => [m, null]));
    let di = 0;
    for (const date of cal) {
      di++;
      const i = cIdx.get(date);
      if (i == null || i < 63 || !cs[i + 1] || cs[i].volume === 0) continue;
      while (j + 1 < chipDates.length && chipDates[j + 1] <= date) j++;
      const hasToday = j >= 0 && chipDates[j] === date;
      const hist = cs.slice(0, i + 1);
      const win = hist.slice(-63);
      const chips: Chips | null = hasToday
        ? { institutionalNetShares: dc[j].inst, foreignNetShares: dc[j].foreign, trustNetShares: dc[j].trust }
        : null;
      const rec: DayRec = {
        sym: u.sym, tier: u.tier, date, idx: di,
        ret: { 5: fwd(cs, i, 5), 10: fwd(cs, i, 10), 20: fwd(cs, i, 20) },
        cross: { simple: null, wilder: null },
        rating: { simple: null, wilder: null },
      };
      for (const m of METHODS) {
        const rv = latestRsi(win.map((c) => c.close), 14, m);
        rec.cross[m] = rv == null ? null : rv >= 70 ? "death" : rv <= 30 ? "golden" : null;
        const core = withRsiMethod(m, () =>
          computeRatingCore({
            symbol: u.sym, name: u.name, price: cs[i].close, market: "TW", candles: win, chaseCandles: hist, asOfDay: date, chips,
            chipsWindow: null, guards: ACTIVE_CHASE_GUARDS, marketRet60Pct: ret60.get(date) ?? null, confirmPrev: states.get(m)!,
          })
        );
        states.set(m, core.rating.confirmState ?? null);
        rec.rating[m] = { code: core.rating.code, hold: core.rating.holdingCode };
      }
      recs.push(rec);
    }
  }

  // 同日同層級平均（全部股票）
  const tierAvg = new Map<string, number>();
  for (const h of HS) {
    const acc = new Map<string, number[]>();
    for (const r of recs) {
      if (r.ret[h] == null) continue;
      const k = `${r.date}|${r.tier}|${h}`;
      if (!acc.has(k)) acc.set(k, []);
      acc.get(k)!.push(r.ret[h]!);
    }
    for (const [k, v] of acc) tierAvg.set(k, mean(v));
  }
  const xt = (r: DayRec, h: H) => (r.ret[h] == null ? null : r.ret[h]! - tierAvg.get(`${r.date}|${r.tier}|${h}`)!);
  const byDateMean = (sel: DayRec[], h: H) => {
    const m = new Map<string, number[]>();
    for (const r of sel) {
      const x = xt(r, h);
      if (x == null) continue;
      if (!m.has(r.date)) m.set(r.date, []);
      m.get(r.date)!.push(x);
    }
    return new Map([...m].map(([d, v]) => [d, mean(v)] as const));
  };
  const stat = (sel: DayRec[], h: H, lag: number) => {
    const dm = byDateMean(sel, h);
    const series = [...dm.keys()].sort().map((d) => dm.get(d)!);
    const xs = sel.map((r) => xt(r, h)).filter((x): x is number => x != null);
    return { n: xs.length, mean: mean(series), pooled: mean(xs), t: nwT(series, lag), win: xs.filter((x) => x > 0).length / (xs.length || 1) };
  };
  const pairedT = (a: DayRec[], b: DayRec[], h: H, lag: number) => {
    const A = byDateMean(a, h), B = byDateMean(b, h);
    const ds = [...A.keys()].filter((d) => B.has(d)).sort().map((d) => A.get(d)! - B.get(d)!);
    return { mean: mean(ds), t: nwT(ds, lag), n: ds.length };
  };

  console.log(`\n## ${p.label}（${used} 檔、${cal.length} 個交易日、${recs.length} 筆股票日）\n`);

  // ---- a. 交叉事件 ----
  const bySym = new Map<string, DayRec[]>();
  for (const r of recs) {
    if (!bySym.has(r.sym)) bySym.set(r.sym, []);
    bySym.get(r.sym)!.push(r);
  }
  const stockDays = recs.length;
  console.log("### a. RSI 極端區（每日、隔日開盤進場；超額＝減同日同層級平均；t＝逐日平均後 NW，落後＝持有日數）\n");
  console.log("| 訊號 | 算法 | 事件數 | 每檔每月次數 | 5日超額（t）勝率 | 10日超額（t）勝率 | 20日超額（t）勝率 |");
  console.log("|---|---|---:|---:|---|---|---|");
  for (const sig of ["death", "golden"] as const) {
    for (const m of METHODS) {
      const sel = recs.filter((r) => r.cross[m] === sig);
      const cells = HS.map((h) => {
        const s = stat(sel, h, h);
        return `${f(s.mean)}（${f(s.t, 1)}）${(s.win * 100).toFixed(0)}%`;
      });
      console.log(`| ${sig === "death" ? "RSI≥70 超買" : "RSI≤30 超賣"} | ${NAME[m]} | ${sel.length} | ${((sel.length / recs.length) * 21).toFixed(3)} | ${cells.join(" | ")} |`);
    }
  }

  // ---- b. 整體評等 ----
  console.log("\n### b. 整體評等（採用版：單日籌碼＋2日確認；每週最後交易日取樣）\n");
  console.log("| 算法 | 買⇄不買翻轉/檔/月 | 持有建議大類翻轉 | 建議買進 10日超額（t，筆數） | 20日（t） | 先不要買 10日（t） | 20日（t） | 買進占比 |");
  console.log("|---|---:|---:|---|---|---|---|---:|");
  const wk = recs.filter((r) => weekly.has(r.date));
  const buyOf = (m: RsiMethod) => wk.filter((r) => r.rating[m]?.code === "buy");
  const avoidOf = (m: RsiMethod) => wk.filter((r) => r.rating[m]?.code === "avoid");
  for (const m of METHODS) {
    let flips = 0, hf = 0, days = 0;
    for (const rs of bySym.values()) {
      days += rs.length;
      for (let k = 1; k < rs.length; k++) {
        const a = rs[k].rating[m]!, b = rs[k - 1].rating[m]!;
        if ((a.code === "buy") !== (b.code === "buy")) flips++;
        if (holdClass(a.hold) !== holdClass(b.hold)) hf++;
      }
    }
    const b = buyOf(m), av = avoidOf(m);
    const b10 = stat(b, 10, 2), b20 = stat(b, 20, 4), a10 = stat(av, 10, 2), a20 = stat(av, 20, 4);
    const share = recs.filter((r) => r.rating[m]?.code === "buy").length / recs.length;
    console.log(`| ${NAME[m]} | ${((flips / days) * 21).toFixed(2)} | ${((hf / days) * 21).toFixed(2)} | ${f(b10.mean)}（${f(b10.t)}，${b10.n}） | ${f(b20.mean)}（${f(b20.t)}） | ${f(a10.mean)}（${f(a10.t)}） | ${f(a20.mean)}（${f(a20.t)}） | ${(share * 100).toFixed(1)}% |`);
  }
  const p10 = pairedT(buyOf("wilder"), buyOf("simple"), 10, 2), p20 = pairedT(buyOf("wilder"), buyOf("simple"), 20, 4);
  const q10 = pairedT(avoidOf("wilder"), avoidOf("simple"), 10, 2), q20 = pairedT(avoidOf("wilder"), avoidOf("simple"), 20, 4);
  console.log(`\n建議買進 Wilder−簡單 逐週配對差：10日 ${f(p10.mean)}（t ${f(p10.t)}，${p10.n} 週）、20日 ${f(p20.mean)}（t ${f(p20.t)}）；先不要買：10日 ${f(q10.mean)}（t ${f(q10.t)}）、20日 ${f(q20.mean)}（t ${f(q20.t)}）`);
  let buyDiff = 0;
  for (const r of recs) if ((r.rating.simple!.code === "buy") !== (r.rating.wilder!.code === "buy")) buyDiff++;
  console.log(`兩算法評等「買／非買」不同的股票日占比：${((buyDiff / recs.length) * 100).toFixed(2)}%`);
}

const which = process.argv[2] ?? "is";
if (which === "is" || which === "both") run(IS);
if (which === "oos" || which === "both") run(OOS);
