/**
 * 擴大樣本回測（200 檔分層、2024-10～2026-08 每週一個訊號日）：
 *   npx tsx scripts/backtest/wideFetch.ts      # 先補資料（可續傳）
 *   npx tsx scripts/backtest/run.ts --wide     # 統計＋寫出 docs/backtest/2026-10-wide.md
 *
 * 設計（門檻全部在下方 LOGICS 事先定好；敏感度只用相鄰 2 組值，全部列出）：
 * - 訊號日收盤判斷、隔日開盤進場，持有 5／10／20 個交易日收盤出場；日K已還原權息。
 * - 超額＝個股報酬 − 同訊號日全樣本等權平均（主要）；另列 − 0050 同期報酬（買進持有大盤）。
 * - 每週只取一個訊號日；統計單位是「每週選中股票的平均超額」這條時間序列
 *   （同週多檔股票高度相關，不能當獨立樣本）。t 值用 Newey-West（落後期數＝ceil(持有日/5)），
 *   95% 信賴區間用區塊 bootstrap（區塊長度＝ceil(持有日/5)+1 週、2000 次）。
 * - 「可靠為正／負」＝ bootstrap 區間不含 0 且 |NW t|>2；其餘「分不出來」。
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle } from "@/lib/data/types";
import { computeRatingCore } from "@/lib/ai/ratingCore";
import type { RatingCode } from "@/lib/ai/siteRating";
import { ACTIVE_CHASE_GUARDS, type ChaseMetrics } from "@/lib/ai/chaseGuards";
import { HORIZONS, REGIME_RET60_PCT, ROUND_TRIP_COST_PCT, SIGNAL_END, SIGNAL_START, WIDE_CACHE_DIR } from "./wideConfig";
import { buildUniverse, loadCandles, loadChips, rankedCount, revenueYoyAsOf, weeklySignalDates, type Tier } from "./wideData";

type H = (typeof HORIZONS)[number];
type Regime = "上漲" | "下跌" | "盤整";

interface WRow {
  sym: string;
  tier: Tier;
  date: string;
  m: ChaseMetrics;
  code: RatingCode;
  tech: string;
  chips: string;
  ma20gt60: boolean | null;
  revYoy: number | null;
  ret: Record<H, number | null>;
  /** 減同日全樣本平均 */
  xs: Record<H, number | null>;
  /** 減同日「同市值層級」平均（中性化大小型股效應；主要指標） */
  xt: Record<H, number | null>;
  /** 減 0050 */
  xm: Record<H, number | null>;
}

const fwd = (cs: Candle[], i: number, h: number) => (cs[i + 1] && cs[i + h] ? (cs[i + h].close / cs[i + 1].open - 1) * 100 : null);
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 資料 ──
const twii = loadCandles("_TWII");
const etf = loadCandles("_0050");
if (!twii || !etf) throw new Error("缺加權指數或 0050 日K，先跑 wideFetch.ts");
const cal = loadCandles("2330")!.map((c) => c.time);
const DATES = weeklySignalDates(cal, SIGNAL_START, SIGNAL_END);
const HALF1 = new Set(DATES.slice(0, Math.ceil(DATES.length / 2)));

const regimeOf = new Map<string, Regime>();
const twiiRet60 = new Map<string, number>();
for (const d of DATES) {
  const i = twii.findIndex((c) => c.time === d);
  if (i < 60) continue;
  const r = (twii[i].close / twii[i - 60].close - 1) * 100;
  twiiRet60.set(d, r);
  regimeOf.set(d, r > REGIME_RET60_PCT ? "上漲" : r < -REGIME_RET60_PCT ? "下跌" : "盤整");
}
const etfRet = new Map<string, Record<H, number | null>>();
for (const d of DATES) {
  const i = etf.findIndex((c) => c.time === d);
  if (i < 0) continue;
  etfRet.set(d, Object.fromEntries(HORIZONS.map((h) => [h, fwd(etf, i, h)])) as Record<H, number | null>);
}

function buildRows(): { rows: WRow[]; universe: ReturnType<typeof buildUniverse>; missing: string[]; chipsDays: number } {
  const universe = buildUniverse();
  const chipsByDate = new Map(DATES.map((d) => [d, loadChips(d)]));
  const chipsDays = [...chipsByDate.values()].filter((m) => m.size > 0).length;
  const rows: WRow[] = [];
  const missing: string[] = [];
  for (const u of universe) {
    const cs = loadCandles(u.sym);
    if (!cs) {
      missing.push(u.sym);
      continue;
    }
    const idx = new Map(cs.map((c, i) => [c.time, i]));
    for (const date of DATES) {
      const i = idx.get(date);
      if (i == null || i < 63 || !cs[i + 1]) continue;
      if (cs[i].volume === 0) continue; // 當天沒成交（停牌）
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
      const closes = hist.map((c) => c.close);
      const avg = (k: number) => mean(closes.slice(-k));
      rows.push({
        sym: u.sym, tier: u.tier, date, m, code,
        tech: scored.facets[0].verdict, chips: scored.facets[1].verdict,
        ma20gt60: closes.length >= 60 ? avg(20) > avg(60) : null,
        revYoy: revenueYoyAsOf(date, u.sym),
        ret: Object.fromEntries(HORIZONS.map((h) => [h, fwd(cs, i, h)])) as Record<H, number | null>,
        xs: {} as Record<H, number | null>,
        xt: {} as Record<H, number | null>,
        xm: {} as Record<H, number | null>,
      });
    }
  }
  for (const d of DATES) {
    const same = rows.filter((r) => r.date === d);
    for (const h of HORIZONS) {
      const avgH = mean(same.map((r) => r.ret[h]).filter((x): x is number => x != null));
      const e = etfRet.get(d)?.[h] ?? null;
      const tierAvg = new Map<Tier, number>();
      for (const t of ["大型", "中型", "小型"] as Tier[])
        tierAvg.set(t, mean(same.filter((r) => r.tier === t).map((r) => r.ret[h]).filter((x): x is number => x != null)));
      for (const r of same) {
        r.xs[h] = r.ret[h] == null ? null : r.ret[h]! - avgH;
        r.xt[h] = r.ret[h] == null ? null : r.ret[h]! - tierAvg.get(r.tier)!;
        r.xm[h] = r.ret[h] == null || e == null ? null : r.ret[h]! - e;
      }
    }
  }
  return { rows, universe, missing, chipsDays };
}

// ── 統計 ──
interface Stat {
  n: number;
  weeks: number;
  mean: number;
  lo: number;
  hi: number;
  t: number;
  median: number;
  win: number;
}

/** 依日期排序的時間序列：Newey-West t 值與區塊 bootstrap 95% 區間。 */
function seriesStat(series: number[], h: number, seed = 1): { mean: number; lo: number; hi: number; t: number } {
  const T = series.length;
  const mu = mean(series);
  if (T < 4) return { mean: mu, lo: NaN, hi: NaN, t: NaN };
  const L = Math.ceil(h / 5);
  const dev = series.map((x) => x - mu);
  const gamma = (l: number) => dev.slice(l).reduce((a, x, k) => a + x * dev[k], 0) / T;
  let v = gamma(0);
  for (let l = 1; l <= L; l++) v += 2 * (1 - l / (L + 1)) * gamma(l);
  const t = v > 0 ? mu / Math.sqrt(v / T) : NaN;
  const b = L + 1;
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
  reps.sort((a, b2) => a - b2);
  return { mean: mu, lo: reps[Math.floor(0.025 * reps.length)], hi: reps[Math.floor(0.975 * reps.length)], t };
}

type Kind = "xs" | "xt" | "xm";
function stat(sel: WRow[], h: H, kind: Kind = "xt"): Stat | null {
  const vals = sel.filter((r) => r[kind][h] != null);
  if (vals.length === 0) return null;
  const byDate = new Map<string, number[]>();
  for (const r of vals) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r[kind][h]!]);
  const series = [...byDate.keys()].sort().map((d) => mean(byDate.get(d)!));
  const s = seriesStat(series, h);
  const pooled = vals.map((r) => r[kind][h]!).sort((a, b) => a - b);
  return {
    n: vals.length, weeks: series.length, ...s,
    median: pooled[Math.floor(pooled.length / 2)],
    win: pooled.filter((x) => x > 0).length / pooled.length,
  };
}

const f2 = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(2)}` : "—");
const verdict = (s: Stat | null) =>
  !s || !Number.isFinite(s.lo) ? "樣本不足" : s.lo > 0 && s.t > 2 ? "**可靠為正**" : s.hi < 0 && s.t < -2 ? "**可靠為負**" : "分不出來";
const cell = (s: Stat | null) => (s ? `${f2(s.mean)} [${f2(s.lo)}, ${f2(s.hi)}]` : "—");

// ── 選股邏輯（門檻事先定好） ──
type Logic = { name: string; f: (r: WRow) => boolean; buySide: boolean };

function topPctSet(rows: WRow[], pct: number): Set<WRow> {
  const out = new Set<WRow>();
  for (const d of DATES) {
    const same = rows.filter((r) => r.date === d && r.m.ret20 != null).sort((a, b) => b.m.ret20! - a.m.ret20!);
    same.slice(0, Math.ceil(same.length * pct)).forEach((r) => out.add(r));
  }
  return out;
}

function logics(rows: WRow[]): Logic[] {
  const top = { 20: topPctSet(rows, 0.2), 30: topPctSet(rows, 0.3), 40: topPctSet(rows, 0.4) };
  const pullback = (band: number) => (r: WRow) =>
    r.ma20gt60 === true && r.m.ma20BiasPct != null && Math.abs(r.m.ma20BiasPct) <= band && r.m.rsi != null && r.m.rsi >= 40 && r.m.rsi <= 55;
  const strong = (s: Set<WRow>) => (r: WRow) => s.has(r) && r.m.rsi != null && r.m.rsi < 65 && r.m.ma20BiasPct != null && r.m.ma20BiasPct < 8;
  const rev = (yoy: number) => (r: WRow) => r.revYoy != null && r.revYoy > yoy && r.m.ma20BiasPct != null && r.m.ma20BiasPct < 5;
  const chase = (r5: number, rsi: number) => (r: WRow) => (r.m.ret5 != null && r.m.ret5 > r5) || (r.m.rsi != null && r.m.rsi >= rsi);
  return [
    { name: "①a 本站評等：建議買進", f: (r) => r.code === "buy", buySide: true },
    { name: "①b 本站評等：等回檔", f: (r) => r.code === "buy-on-pullback", buySide: true },
    { name: "①c 本站評等：先不要買", f: (r) => r.code === "avoid", buySide: false },
    { name: "②a 舊技術面評分：支持", f: (r) => r.tech === "支持", buySide: true },
    { name: "②b 舊技術面評分：不支持", f: (r) => r.tech === "不支持", buySide: false },
    { name: "②c 舊推薦（技術支持＋籌碼不反對）", f: (r) => r.tech === "支持" && r.chips !== "不支持", buySide: true },
    { name: "③ 多頭回檔（±3%）", f: pullback(3), buySide: true },
    { name: "　③ 敏感度 ±2%", f: pullback(2), buySide: true },
    { name: "　③ 敏感度 ±5%", f: pullback(5), buySide: true },
    { name: "④ 相對強勢未過熱（前30%）", f: strong(top[30]), buySide: true },
    { name: "　④ 敏感度 前20%", f: strong(top[20]), buySide: true },
    { name: "　④ 敏感度 前40%", f: strong(top[40]), buySide: true },
    { name: "⑤ 營收年增>20%＋距MA20<5%", f: rev(20), buySide: true },
    { name: "　⑤ 敏感度 年增>10%", f: rev(10), buySide: true },
    { name: "　⑤ 敏感度 年增>30%", f: rev(30), buySide: true },
    { name: "⑥ 追高（5日>15%或RSI≥75）", f: chase(15, 75), buySide: false },
    { name: "　⑥ 敏感度（10%／70）", f: chase(10, 70), buySide: false },
    { name: "　⑥ 敏感度（20%／80）", f: chase(20, 80), buySide: false },
  ];
}

function randomBand(rows: WRow[], h: H, kind: Kind, frac = 0.1, reps = 300): { lo: number; hi: number; sd: number } {
  const rnd = mulberry32(7);
  const byDate = new Map<string, WRow[]>();
  for (const r of rows) if (r[kind][h] != null) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const out: number[] = [];
  for (let k = 0; k < reps; k++) {
    const series: number[] = [];
    for (const rs of byDate.values()) {
      const pick = rs.filter(() => rnd() < frac);
      if (pick.length) series.push(mean(pick.map((r) => r[kind][h]!)));
    }
    out.push(mean(series));
  }
  out.sort((a, b) => a - b);
  const mu = mean(out);
  return { lo: out[Math.floor(0.025 * reps)], hi: out[Math.floor(0.975 * reps)], sd: Math.sqrt(mean(out.map((x) => (x - mu) ** 2))) };
}

export function runWide() {
  const { rows, universe, missing, chipsDays } = buildRows();
  const L = logics(rows);
  const out: string[] = [];
  const p = (s = "") => out.push(s);
  const regimeCount = (g: Regime) => DATES.filter((d) => regimeOf.get(d) === g).length;
  const syms = new Set(rows.map((r) => r.sym));

  p("# 擴大樣本回測（2026-10）：哪些選股邏輯真的有效");
  p();
  p(`> 產生方式：\`npx tsx scripts/backtest/wideFetch.ts\` 下載資料後 \`npx tsx scripts/backtest/run.ts --wide\`。本檔由程式產生，請勿手改數字。`);
  p();
  p("## 方法");
  p();
  p(`- **樣本**：${SIGNAL_START}～${SIGNAL_END} 每週最後一個交易日當訊號日，共 ${DATES.length} 週；股票池 ${universe.length} 檔，實際有日K ${syms.size} 檔，共 ${rows.length} 筆（股票×週）。`);
  p(`- **選樣（避免前視）**：只用訊號期開始前（2024-09-23～09-30）上市＋上櫃普通股的平均成交金額排名（當時共約 ${rankedCount()} 檔普通股；排除 ETF／ETN、存託憑證，興櫃不在行情表內）。大型＝前 60 全取；中型＝第 61～300 名隨機抽 70；小型＝第 301～900 名隨機抽 70（900 名以後成交太少不抽）；固定亂數種子可重現。`);
  p(`- **存活者偏差**：選樣只用期初資訊，沒有用「現在還在」的名單，所以沒有前視型偏差；殘餘偏差是 Yahoo 已下架（下市）的股票抓不到日K：${universe.length} 檔中抓不到 ${missing.length} 檔${missing.length ? `（${missing.join("、")}）` : ""}。沒有每季重新選樣（每季重選需要全市場每季行情，留待之後），所以後期新上市、後來才變熱門的股票不在樣本內——這讓樣本偏向「期初就大的公司」，但不會讓任何邏輯的超額系統性變好。`);
  p(`- **進出場**：訊號日收盤判斷、下一交易日開盤買進、第 5／10／20 個交易日收盤賣出；日K用 Yahoo 還原權息（除權息不會被當成下跌）。`);
  p(`- **超額報酬**：主要＝個股報酬 − 同訊號日「同市值層級」等權平均（扣掉大盤漲跌，也扣掉這兩年大型股遠強於中小型股的規模效應——不中性化的話，任何偏向大型股的邏輯都會白撿超額）；另列 − 同日全樣本平均、− 0050 同期報酬。**交易成本**：表中超額是未扣成本的「選股能力」；實際可賺要再扣來回 ${ROUND_TRIP_COST_PCT}%（「扣成本」欄＝平均−${ROUND_TRIP_COST_PCT}）。`);
  p(`- **統計**：同一週的多檔股票高度相關，所以統計單位是「每週選中股票的平均超額」這條 ${DATES.length} 週的時間序列（＝每週等權買入的組合）。t 值用 Newey-West（落後期數＝ceil(持有日÷5)，處理 10／20 日持有期的重疊）；95% 信賴區間用區塊 bootstrap（區塊＝ceil(持有日÷5)+1 週，2000 次）。**判定**：區間不含 0 且 |t|>2 才算「可靠為正／負」，其餘「分不出來」。`);
  p(`- **市況分段**：訊號日加權指數近 60 個交易日報酬 > +${REGIME_RET60_PCT}% 為上漲、< −${REGIME_RET60_PCT}% 為下跌、其餘盤整（純客觀規則，事先定好）。本樣本：上漲 ${regimeCount("上漲")} 週、下跌 ${regimeCount("下跌")} 週、盤整 ${regimeCount("盤整")} 週。`);
  p(`- **前後半期（樣本外檢查）**：前半 ${[...HALF1][0]}～${[...HALF1].at(-1)}、後半 ${DATES.find((d) => !HALF1.has(d))}～${DATES.at(-1)}。門檻沒有依任何一半調整，所以兩半都算樣本外；方向一致才可信。`);
  p(`- **本站評等的近似**：直接呼叫正式評等核心 computeRatingCore()（跟正式站 stockRating.ts 同一個；現行追高防護：${ACTIVE_CHASE_GUARDS.join("、")}）。歷史的本益比、財報、持股結構、新聞拿不到，一律「無資料」，所以「建議買進」在這裡＝技術面支持＋三大法人當日買超＋價位條件，比正式站少三個面向。三大法人取自證交所 T86＋櫃買每日法人表（${chipsDays}/${DATES.length} 週有資料）。`);
  p(`- **月營收**：公開資訊觀測站上市＋上櫃彙總表；訊號日只用當時已公布的月份（次月 11 日起才用）。覆蓋 ${rows.filter((r) => r.revYoy != null).length}/${rows.length} 筆。`);
  p();

  const sum = (label: string, kind: Kind) => {
    p(`## ${label}`);
    p();
    p("| 邏輯 | 筆數 | " + HORIZONS.map((h) => `${h}日超額% [95%區間]｜t｜判定`).join(" | ") + ` | 10日中位 | 10日跑贏 | 10日扣成本 |`);
    p("|---|---:|" + HORIZONS.map(() => "---|").join("") + "---:|---:|---:|");
    for (const lg of L) {
      const sel = rows.filter(lg.f);
      const ss = HORIZONS.map((h) => stat(sel, h, kind));
      const s10 = ss[1];
      p(
        `| ${lg.name} | ${sel.length} | ` +
          ss.map((s) => (s ? `${cell(s)}｜${f2(s.t)}｜${verdict(s)}` : "—")).join(" | ") +
          ` | ${s10 ? f2(s10.median) : "—"} | ${s10 ? (s10.win * 100).toFixed(0) + "%" : "—"} | ${lg.buySide && s10 ? f2(s10.mean - ROUND_TRIP_COST_PCT) : "—"} |`
      );
    }
    if (kind !== "xm") {
      const e = HORIZONS.map((h) => {
        const series = DATES.map((d) => {
          const same = rows.filter((r) => r.date === d && r.ret[h] != null);
          const er = etfRet.get(d)?.[h];
          return same.length && er != null ? er - mean(same.map((r) => r.ret[h]!)) : null;
        }).filter((x): x is number => x != null);
        const s = seriesStat(series, h);
        return `${f2(s.mean)} [${f2(s.lo)}, ${f2(s.hi)}]｜${f2(s.t)}｜${verdict({ ...s, n: series.length, weeks: series.length, median: 0, win: 0 })}`;
      });
      p(`| ⑦a 基準：買進持有 0050（相對全樣本平均） | ${DATES.length}週 | ${e.join(" | ")} | — | — | — |`);
      const rb = HORIZONS.map((h) => randomBand(rows, h, kind));
      p(`| ⑦b 基準：每週隨機抽 10%（300 次的 95% 範圍＝運氣帶） | — | ${rb.map((b) => `[${f2(b.lo)}, ${f2(b.hi)}]`).join(" | ")} | — | — | — |`);
    }
    p();
  };
  sum("一、全期（主要：超額＝減同日「同市值層級」平均）", "xt");
  sum("一之二、全期（超額＝減同日全樣本平均，未中性化市值；大型股這兩年明顯強於中小型，會讓偏大型股的邏輯看起來比較好）", "xs");

  const breakdown = (h: H) => {
    p(`## 二、${h} 日超額（減同日同層級平均）：依市況與前後半期（平均 [95%區間]，括號後為判定）`);
    p();
    p("| 邏輯 | 上漲 | 下跌 | 盤整 | 前半 | 後半 |");
    p("|---|---|---|---|---|---|");
    for (const lg of L) {
      const sel = rows.filter(lg.f);
      const parts = [
        ...(["上漲", "下跌", "盤整"] as Regime[]).map((g) => sel.filter((r) => regimeOf.get(r.date) === g)),
        sel.filter((r) => HALF1.has(r.date)),
        sel.filter((r) => !HALF1.has(r.date)),
      ].map((s) => {
        const st = stat(s, h);
        return st ? `${cell(st)} ${verdict(st).replace(/\*/g, "")}（${st.n}筆）` : "—";
      });
      p(`| ${lg.name} | ${parts.join(" | ")} |`);
    }
    p();
  };
  breakdown(10);
  breakdown(20);

  p("## 三、10 日超額（減同日同層級平均）：依市值層級");
  p();
  p("| 邏輯 | 大型 | 中型 | 小型 |");
  p("|---|---|---|---|");
  for (const lg of L) {
    const sel = rows.filter(lg.f);
    const parts = (["大型", "中型", "小型"] as Tier[]).map((t) => {
      const st = stat(sel.filter((r) => r.tier === t), 10);
      return st ? `${cell(st)} ${verdict(st).replace(/\*/g, "")}（${st.n}筆）` : "—";
    });
    p(`| ${lg.name} | ${parts.join(" | ")} |`);
  }
  p();
  sum("四、全期（超額＝減 0050 同期報酬；含小型股整體相對大盤的表現）", "xm");

  p("## 附：各市況下全樣本平均報酬（未扣大盤）");
  p();
  p("| 市況 | 週數 | 全樣本 10 日平均報酬% | 0050 10 日平均報酬% |");
  p("|---|---:|---:|---:|");
  for (const g of ["上漲", "下跌", "盤整"] as Regime[]) {
    const ds = DATES.filter((d) => regimeOf.get(d) === g);
    const all = mean(ds.map((d) => mean(rows.filter((r) => r.date === d && r.ret[10] != null).map((r) => r.ret[10]!))).filter(Number.isFinite));
    const e = mean(ds.map((d) => etfRet.get(d)?.[10]).filter((x): x is number => x != null));
    p(`| ${g} | ${ds.length} | ${f2(all)} | ${f2(e)} |`);
  }
  p();

  const dir = path.join(process.cwd(), "docs", "backtest");
  fs.mkdirSync(dir, { recursive: true });
  const fn = path.join(dir, "2026-10-wide.md");
  fs.writeFileSync(fn, out.join("\n"));
  console.log(out.join("\n"));
  console.log(`\n已寫入 ${fn}（快取 ${WIDE_CACHE_DIR}）`);
}
