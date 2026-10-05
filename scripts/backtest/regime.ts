/**
 * 研究題目 C：大盤市況開關（規則見 regimeConfig.ts 與 docs/backtest/2026-10-regime.md 第〇節，事先登錄）。
 *   npx tsx scripts/backtest/regimeFetch.ts   # 樣本外資料（可續傳）
 *   npx tsx scripts/backtest/regime.ts        # 統計 → 印出結果（docs 的結果段落由此貼上）
 *
 * 每列（股票×訊號週）計算方式與 wide.ts buildRows 相同（同一套 score()／computeSiteRating()／computeChaseMetrics()），
 * 這裡重寫一份而不 import wide.ts，是因為 wide.ts 的期間與快取目錄在模組載入時就寫死，且不能改動它（另一個 agent 在用）。
 */
import type { Candle } from "@/lib/data/types";
import { computeRatingCore } from "@/lib/ai/ratingCore";
import type { RatingCode } from "@/lib/ai/siteRating";
import { ACTIVE_CHASE_GUARDS } from "@/lib/ai/chaseGuards";
import { ROUND_TRIP_COST_PCT } from "./wideConfig";
import { weeklySignalDates, type Tier } from "./wideData";
import { IS, OOS, REGIME_A_PCT, REGIME_B_MA, type PeriodConfig } from "./regimeConfig";
import { buildUniverseFor, loadCandlesFor, loadChipsFor } from "./regimeData";

const HS = [10, 20] as const;
type H = (typeof HS)[number];
type RegA = "上漲" | "盤整" | "下跌";

interface Row {
  sym: string;
  tier: Tier;
  date: string;
  code: RatingCode;
  tech: string;
  chase: boolean;
  ret: Record<H, number | null>;
  xt: Record<H, number | null>;
  /** 訊號日收盤後 10 個交易日內最低價相對訊號日收盤（%），衡量「等回檔」有沒有機會買更便宜 */
  dip10: number | null;
}

interface WeekInfo {
  regA: RegA;
  weakA: boolean;
  weakB: boolean;
  ret60: number;
  /** 加權指數訊號日隔日開盤→第 h 日收盤報酬（市場本身之後漲跌） */
  mkt: Record<H, number | null>;
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const fwd = (cs: Candle[], i: number, h: number) => (cs[i + 1] && cs[i + h] ? (cs[i + h].close / cs[i + 1].open - 1) * 100 : null);

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function build(p: PeriodConfig) {
  const { universe, rankedTotal } = buildUniverseFor(p);
  const twii = loadCandlesFor(p, "_TWII");
  if (!twii) throw new Error(`缺加權指數日K（${p.cacheDir}）`);
  const cal = loadCandlesFor(p, "2330")!.map((c) => c.time);
  const dates = weeklySignalDates(cal, p.signalStart, p.signalEnd);
  const week = new Map<string, WeekInfo>();
  const tIdx = new Map(twii.map((c, i) => [c.time, i]));
  for (const d of dates) {
    const i = tIdx.get(d);
    if (i == null || i < REGIME_B_MA) continue;
    const ret60 = (twii[i].close / twii[i - 60].close - 1) * 100;
    const ma = mean(twii.slice(i - REGIME_B_MA + 1, i + 1).map((c) => c.close));
    week.set(d, {
      ret60,
      regA: ret60 > REGIME_A_PCT ? "上漲" : ret60 < -REGIME_A_PCT ? "下跌" : "盤整",
      weakA: ret60 < REGIME_A_PCT,
      weakB: twii[i].close < ma,
      mkt: { 10: fwd(twii, i, 10), 20: fwd(twii, i, 20) },
    });
  }
  const rows: Row[] = [];
  const missing: string[] = [];
  const chipsByDate = new Map(dates.map((d) => [d, loadChipsFor(p, d)]));
  const chipsDays = [...chipsByDate.values()].filter((m) => m.size > 0).length;
  for (const u of universe) {
    const cs = loadCandlesFor(p, u.sym);
    if (!cs) {
      missing.push(`${u.sym}${u.name}（${u.tier}）`);
      continue;
    }
    const idx = new Map(cs.map((c, i) => [c.time, i]));
    for (const date of dates) {
      const i = idx.get(date);
      if (i == null || i < 63 || !cs[i + 1] || !week.has(date)) continue;
      if (cs[i].volume === 0) continue;
      const price = cs[i].close;
      const hist = cs.slice(0, i + 1);
      const win = hist.slice(-63);
      const chips = chipsByDate.get(date)?.get(u.sym) ?? null;
      // 正式評等核心（src/lib/ai/ratingCore.ts，跟 stockRating.ts 同一個函式）。
      const core = computeRatingCore({
        symbol: u.sym, name: u.name, price, market: "TW", candles: win, chaseCandles: hist, asOfDay: date, chips,
        guards: ACTIVE_CHASE_GUARDS,
      });
      const { scored } = core;
      const m = core.chase!;
      const code = core.rating.code;
      const next10 = cs.slice(i + 1, i + 11);
      rows.push({
        sym: u.sym, tier: u.tier, date, code,
        tech: scored.facets[0].verdict,
        chase: (m.ret5 != null && m.ret5 > 15) || (m.rsi != null && m.rsi >= 75),
        ret: { 10: fwd(cs, i, 10), 20: fwd(cs, i, 20) },
        xt: { 10: null, 20: null },
        dip10: next10.length ? (Math.min(...next10.map((c) => c.low)) / price - 1) * 100 : null,
      });
    }
  }
  for (const d of dates) {
    const same = rows.filter((r) => r.date === d);
    for (const h of HS) {
      const tierAvg = new Map<Tier, number>();
      for (const t of ["大型", "中型", "小型"] as Tier[])
        tierAvg.set(t, mean(same.filter((r) => r.tier === t && r.ret[h] != null).map((r) => r.ret[h]!)));
      for (const r of same) r.xt[h] = r.ret[h] == null ? null : r.ret[h]! - tierAvg.get(r.tier)!;
    }
  }
  return { p, universe, rankedTotal, rows, missing, week, dates: dates.filter((d) => week.has(d)), chipsDays };
}
type Built = ReturnType<typeof build>;

// ── 統計（與 wide.ts 相同：每週序列、NW t、區塊 bootstrap） ──
function seriesStat(series: number[], h: number, seed = 1) {
  const T = series.length;
  const mu = mean(series);
  if (T < 4) return { mean: mu, lo: NaN, hi: NaN, t: NaN, T };
  const L = Math.ceil(h / 5);
  const dev = series.map((x) => x - mu);
  const gamma = (l: number) => dev.slice(l).reduce((a, x, k) => a + x * dev[k], 0) / T;
  let v = gamma(0);
  for (let l = 1; l <= L; l++) v += 2 * (1 - l / (L + 1)) * gamma(l);
  const t = v > 0 ? mu / Math.sqrt(v / T) : NaN;
  const b = Math.min(L + 1, T);
  const rnd = mulberry32(seed);
  const reps: number[] = [];
  for (let r = 0; r < 2000; r++) {
    let s = 0, k = 0;
    while (k < T) {
      const st = Math.floor(rnd() * (T - b + 1));
      for (let j = 0; j < b && k < T; j++, k++) s += series[st + j];
    }
    reps.push(s / T);
  }
  reps.sort((a, c) => a - c);
  return { mean: mu, lo: reps[Math.floor(0.025 * reps.length)], hi: reps[Math.floor(0.975 * reps.length)], t, T };
}
type S = ReturnType<typeof seriesStat>;

/** 依週平均 → 時間序列統計。val 回傳 null 的列略過。 */
function weekly(sel: Row[], h: H, val: (r: Row) => number | null) {
  const by = new Map<string, number[]>();
  for (const r of sel) {
    const v = val(r);
    if (v == null) continue;
    by.set(r.date, [...(by.get(r.date) ?? []), v]);
  }
  const series = [...by.keys()].sort().map((d) => mean(by.get(d)!));
  return { s: seriesStat(series, h), n: [...by.values()].reduce((a, v) => a + v.length, 0) };
}

const f2 = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(2)}` : "—");
const verdict = (s: S) =>
  !Number.isFinite(s.lo) ? "樣本不足" : s.lo > 0 && s.t > 2 ? "**可靠為正**" : s.hi < 0 && s.t < -2 ? "**可靠為負**" : "分不出來";
const cell = (s: S) => (Number.isFinite(s.mean) ? `${f2(s.mean)} [${f2(s.lo)}, ${f2(s.hi)}]｜t ${f2(s.t)}｜${verdict(s)}` : "—");

const GROUPS: Array<{ name: string; f: (r: Row) => boolean }> = [
  { name: "①建議買進", f: (r) => r.code === "buy" },
  { name: "②a技術支持", f: (r) => r.tech === "支持" },
  { name: "⑥追高", f: (r) => r.chase },
];

const out: string[] = [];
const p = (s = "") => out.push(s);

function regimeTable(B: Built, h: H) {
  p(`#### ${B.p.label}：${h} 日超額（減同日同層級平均，未扣成本）`);
  p();
  p("| 邏輯 | A 上漲 | A 盤整 | A 下跌 | A 弱（盤整＋下跌） | B 強（≥MA60） | B 弱（<MA60） |");
  p("|---|---|---|---|---|---|---|");
  for (const g of GROUPS) {
    const sel = B.rows.filter(g.f);
    const parts = [
      ...(["上漲", "盤整", "下跌"] as RegA[]).map((a) => sel.filter((r) => B.week.get(r.date)!.regA === a)),
      sel.filter((r) => B.week.get(r.date)!.weakA),
      sel.filter((r) => !B.week.get(r.date)!.weakB),
      sel.filter((r) => B.week.get(r.date)!.weakB),
    ].map((s) => {
      const w = weekly(s, h, (r) => r.xt[h]);
      return `${cell(w.s)}（${w.n}筆/${w.s.T}週）`;
    });
    p(`| ${g.name} | ${parts.join(" | ")} |`);
  }
  p();
}

/** 開關比較：被關掉的那批（弱市況的建議買進）vs 保留的那批；以及整體策略有／無開關的每週平均。 */
function switchTable(B: Built, def: "A" | "B", grp = GROUPS[0]) {
  const weak = (d: string) => (def === "A" ? B.week.get(d)!.weakA : B.week.get(d)!.weakB);
  const sel = B.rows.filter(grp.f);
  const off = sel.filter((r) => weak(r.date));
  const on = sel.filter((r) => !weak(r.date));
  p(`#### ${B.p.label}｜定義 ${def}｜${grp.name}（弱市況週數 ${B.dates.filter(weak).length}/${B.dates.length}）`);
  p();
  p("| 批次 | 持有 | 筆數/週數 | 絕對報酬−成本% [95%區間]｜判定 | 超額% [95%區間]｜t｜判定 | 超額−成本% | 加權指數同期% | 10日內曾回檔≥3% |");
  p("|---|---|---|---|---|---|---|---|");
  for (const [label, s] of [["被關掉（弱市況→改等回檔）", off], ["保留（強市況照買）", on], ["沒開關（全部照買）", sel]] as const) {
    for (const h of HS) {
      const abs = weekly(s, h, (r) => (r.ret[h] == null ? null : r.ret[h]! - ROUND_TRIP_COST_PCT));
      const xt = weekly(s, h, (r) => r.xt[h]);
      const mk = mean([...new Set(s.map((r) => r.date))].map((d) => B.week.get(d)!.mkt[h]).filter((x): x is number => x != null));
      const dips = s.filter((r) => r.dip10 != null);
      const dipPct = dips.length ? `${((dips.filter((r) => r.dip10! <= -3).length / dips.length) * 100).toFixed(0)}%` : "—";
      p(`| ${label} | ${h}日 | ${abs.n}/${abs.s.T} | ${cell(abs.s)} | ${cell(xt.s)} | ${f2(xt.s.mean - ROUND_TRIP_COST_PCT)} | ${f2(mk)} | ${h === 10 ? dipPct : ""} |`);
    }
  }
  // 策略層級：每週（所有訊號週）平均扣成本報酬；沒有買進或被關掉的週＝持有現金 0。差＝有開關−沒開關。
  for (const h of HS) {
    const byDate = new Map<string, number[]>();
    for (const r of sel) if (r.ret[h] != null) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r.ret[h]! - ROUND_TRIP_COST_PCT]);
    const noSw = B.dates.map((d) => (byDate.has(d) ? mean(byDate.get(d)!) : 0));
    const sw = B.dates.map((d, k) => (weak(d) ? 0 : noSw[k]));
    const diff = seriesStat(sw.map((x, k) => x - noSw[k]), h);
    p(`| **策略每週平均（現金＝0）** | ${h}日 | ${B.dates.length}週 | 沒開關 ${f2(mean(noSw))}／有開關 ${f2(mean(sw))} | 差（有−沒）${cell(diff)} | | | |`);
  }
  p();
}

function marketTable(B: Built) {
  p(`#### ${B.p.label}：各市況週數與加權指數之後表現`);
  p();
  p("| 市況 | 週數 | 加權指數之後 10 日% | 之後 20 日% | 之後 20 日上漲的週比例 |");
  p("|---|---:|---:|---:|---:|");
  const seg: Array<[string, (w: WeekInfo) => boolean]> = [
    ["A 上漲", (w) => w.regA === "上漲"], ["A 盤整", (w) => w.regA === "盤整"], ["A 下跌", (w) => w.regA === "下跌"],
    ["B 強", (w) => !w.weakB], ["B 弱", (w) => w.weakB],
  ];
  for (const [label, f] of seg) {
    const ws = B.dates.map((d) => B.week.get(d)!).filter(f);
    const m20 = ws.map((w) => w.mkt[20]).filter((x): x is number => x != null);
    p(`| ${label} | ${ws.length} | ${f2(mean(ws.map((w) => w.mkt[10]).filter((x): x is number => x != null)))} | ${f2(mean(m20))} | ${m20.length ? ((m20.filter((x) => x > 0).length / m20.length) * 100).toFixed(0) + "%" : "—"} |`);
  }
  const agree = B.dates.filter((d) => B.week.get(d)!.weakA === B.week.get(d)!.weakB).length;
  p();
  p(`定義 A 與 B 的「弱」判斷一致的週：${agree}/${B.dates.length}。`);
  p();
}

const t0 = Date.now();
const periods = [build(OOS), build(IS)];
for (const B of periods) {
  p(`### ${B.p.label} 樣本`);
  p();
  p(`- 選樣期普通股 ${B.rankedTotal} 檔；股票池 ${B.universe.length} 檔，抓不到日K ${B.missing.length} 檔${B.missing.length ? `：${B.missing.join("、")}` : ""}。`);
  p(`- 訊號週 ${B.dates.length}（${B.dates[0]}～${B.dates.at(-1)}），共 ${B.rows.length} 筆；三大法人有資料 ${B.chipsDays}/${B.dates.length} 週。`);
  p(`- 「建議買進」${B.rows.filter((r) => r.code === "buy").length} 筆、技術支持 ${B.rows.filter((r) => r.tech === "支持").length} 筆、追高 ${B.rows.filter((r) => r.chase).length} 筆。`);
  p();
  marketTable(B);
}
p("### 各市況超額");
p();
for (const B of periods) for (const h of HS) regimeTable(B, h);
p("### 開關比較（建議買進）");
p();
for (const B of periods) for (const d of ["A", "B"] as const) switchTable(B, d);
p("### 開關比較（若把開關套在技術支持組）");
p();
for (const B of periods) switchTable(B, "A", GROUPS[1]);
console.log(out.join("\n"));
console.error(`完成（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
