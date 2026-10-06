/**
 * KD 算法比較回測（2026-10-07 使用者問「現在的 KD 跟券商 App 差異在哪？哪個會比較準？」）。
 *   npx tsx scripts/backtest/kdFormula.ts [is|oos|both]
 * 資料全用既有快取（K線＋FinMind 每日三大法人，不打證交所）。樣本與 stability.ts 相同（樣本內 198 檔／樣本外 194 檔）。
 *
 * 比較兩種 KD（參數同為 9,3,3）：
 *   sma       本站現行：K＝RSV 的 3 日簡單平均、D＝K 的 3 日簡單平均
 *   recursive 券商慣用：K＝2/3×前K＋1/3×RSV、D＝2/3×前D＋1/3×K，初值 50
 * 事先定好的指標（看結果前寫死）：
 *   a. 「KD 黃金交叉／死亡交叉」當日出現（訊號日收盤後確認）→ 隔日開盤進場、5／10／20 日後收盤的超額報酬
 *      （減同日同市值層級平均）、勝率（超額>0 比例）、事件數、每檔每月次數、5 日內被反向交叉推翻的比例；
 *      t 值＝逐日平均後 Newey-West（落後期數＝持有日數，日頻重疊重）。另列「兩算法同日都交叉／只有單一算法交叉」。
 *   b. 整體評等（正式評等核心 computeRatingCore，採用版＝單日籌碼＋2日確認）建議買進／先不要買 10／20 日超額與 t
 *      （每週最後交易日取樣，同 stability.ts），每檔每月翻轉次數；並用逐週「遞迴−SMA」差序列做配對 t。
 * 預設行為不變：只用 withKdMethod() 在回測內暫時切換，正式站不受影響。
 */
import type { Candle, Chips } from "@/lib/data/types";
import { computeRatingCore } from "@/lib/ai/ratingCore";
import type { ConfirmState } from "@/lib/ai/ratingStability";
import { ACTIVE_CHASE_GUARDS } from "@/lib/ai/chaseGuards";
import type { HoldingCode, RatingCode } from "@/lib/ai/siteRating";
import { computeKd } from "@/lib/signals";
import { withKdMethod, type KdMethod } from "@/lib/kdFormula";
import fs from "node:fs";
import path from "node:path";
import { weeklySignalDates, type Tier } from "./wideData";
import { IS, OOS, type PeriodConfig } from "./regimeConfig";
import { buildUniverseFor, loadCandlesFor } from "./regimeData";

const HS = [5, 10, 20] as const;
type H = (typeof HS)[number];
const METHODS: KdMethod[] = ["sma", "recursive"];
const NAME: Record<KdMethod, string> = { sma: "SMA（現行）", recursive: "遞迴（券商）" };

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

type Cross = "golden" | "death" | null;
interface DayRec {
  sym: string; tier: Tier; date: string; idx: number;
  ret: Record<H, number | null>;
  cross: Record<KdMethod, Cross>;
  rating: Record<KdMethod, { code: RatingCode; hold: HoldingCode } | null>;
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
    const states = new Map<KdMethod, ConfirmState | null>(METHODS.map((m) => [m, null]));
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
        cross: { sma: null, recursive: null },
        rating: { sma: null, recursive: null },
      };
      for (const m of METHODS) {
        rec.cross[m] = computeKd(win, m)?.cross ?? null;
        const core = withKdMethod(m, () =>
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
  console.log("### a. KD 交叉訊號（每日、隔日開盤進場；超額＝減同日同層級平均；t＝逐日平均後 NW，落後＝持有日數）\n");
  console.log("| 訊號 | 算法 | 事件數 | 每檔每月次數 | 5日內被反向交叉推翻 | 5日超額（t）勝率 | 10日超額（t）勝率 | 20日超額（t）勝率 |");
  console.log("|---|---|---:|---:|---:|---|---|---|");
  for (const sig of ["golden", "death"] as const) {
    for (const m of METHODS) {
      const sel = recs.filter((r) => r.cross[m] === sig);
      // 推翻：同一檔之後 5 個交易日內出現反向交叉
      let rev = 0;
      for (const rs of bySym.values()) {
        const ev = rs.filter((r) => r.cross[m] != null).map((r) => ({ idx: r.idx, cross: r.cross[m] }));
        for (let k = 0; k < ev.length; k++) {
          if (ev[k].cross !== sig) continue;
          const nx = ev.slice(k + 1).find((e) => e.cross !== sig);
          if (nx && nx.idx - ev[k].idx <= 5) rev++;
        }
      }
      const cells = HS.map((h) => {
        const s = stat(sel, h, h);
        return `${f(s.mean)}（${f(s.t, 1)}）${(s.win * 100).toFixed(0)}%`;
      });
      console.log(`| ${sig === "golden" ? "黃金交叉" : "死亡交叉"} | ${NAME[m]} | ${sel.length} | ${((sel.length / stockDays) * 21).toFixed(3)} | ${((rev / sel.length) * 100).toFixed(0)}% | ${cells.join(" | ")} |`);
    }
  }
  console.log("\n兩算法同日交叉重疊度，與配對差（遞迴−SMA 的逐日平均超額差，t）：\n");
  console.log("| 訊號 | 兩者同日都有 | 僅 SMA | 僅遞迴 | 同日都有 10日超額（t） | 僅 SMA 10日（t） | 僅遞迴 10日（t） | 全體配對差 10日（t） | 20日（t） |");
  console.log("|---|---:|---:|---:|---|---|---|---|---|");
  for (const sig of ["golden", "death"] as const) {
    const both = recs.filter((r) => r.cross.sma === sig && r.cross.recursive === sig);
    const onlyS = recs.filter((r) => r.cross.sma === sig && r.cross.recursive !== sig);
    const onlyR = recs.filter((r) => r.cross.recursive === sig && r.cross.sma !== sig);
    const sS = recs.filter((r) => r.cross.sma === sig), sR = recs.filter((r) => r.cross.recursive === sig);
    const c = (sel: DayRec[]) => {
      const s = stat(sel, 10, 10);
      return `${f(s.mean)}（${f(s.t, 1)}）`;
    };
    const d10 = pairedT(sR, sS, 10, 10), d20 = pairedT(sR, sS, 20, 20);
    console.log(`| ${sig === "golden" ? "黃金" : "死亡"} | ${both.length} | ${onlyS.length} | ${onlyR.length} | ${c(both)} | ${c(onlyS)} | ${c(onlyR)} | ${f(d10.mean)}（${f(d10.t, 1)}） | ${f(d20.mean)}（${f(d20.t, 1)}） |`);
  }

  // ---- b. 整體評等 ----
  console.log("\n### b. 整體評等（採用版：單日籌碼＋2日確認；每週最後交易日取樣）\n");
  console.log("| 算法 | 買⇄不買翻轉/檔/月 | 持有建議大類翻轉 | 建議買進 10日超額（t，筆數） | 20日（t） | 先不要買 10日（t） | 20日（t） | 買進占比 |");
  console.log("|---|---:|---:|---|---|---|---|---:|");
  const wk = recs.filter((r) => weekly.has(r.date));
  const buyOf = (m: KdMethod) => wk.filter((r) => r.rating[m]?.code === "buy");
  const avoidOf = (m: KdMethod) => wk.filter((r) => r.rating[m]?.code === "avoid");
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
  const p10 = pairedT(buyOf("recursive"), buyOf("sma"), 10, 2), p20 = pairedT(buyOf("recursive"), buyOf("sma"), 20, 4);
  const q10 = pairedT(avoidOf("recursive"), avoidOf("sma"), 10, 2), q20 = pairedT(avoidOf("recursive"), avoidOf("sma"), 20, 4);
  console.log(`\n建議買進 遞迴−SMA 逐週配對差：10日 ${f(p10.mean)}（t ${f(p10.t)}，${p10.n} 週）、20日 ${f(p20.mean)}（t ${f(p20.t)}）；先不要買：10日 ${f(q10.mean)}（t ${f(q10.t)}）、20日 ${f(q20.mean)}（t ${f(q20.t)}）`);
  let buyDiff = 0;
  for (const r of recs) if ((r.rating.sma!.code === "buy") !== (r.rating.recursive!.code === "buy")) buyDiff++;
  console.log(`兩算法評等「買／非買」不同的股票日占比：${((buyDiff / recs.length) * 100).toFixed(2)}%`);
}

const which = process.argv[2] ?? "is";
if (which === "is" || which === "both") run(IS);
if (which === "oos" || which === "both") run(OOS);
