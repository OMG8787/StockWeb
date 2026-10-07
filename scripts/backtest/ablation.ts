/**
 * 評等消融實驗與權重最佳化（2026-10-07 使用者：「做消融實驗，一次只改一部份，看各變數的好壞影響來慢慢優化判斷；
 * 拿以前數據來訓練，但不能看到以當下來說未來的資料，像訓練集、驗證集、測試集」「透過消融實驗修改每個變數的權重，讓結果最佳化」）。
 *   npx tsx scripts/backtest/ablationData.ts is && npx tsx scripts/backtest/ablationData.ts oos   # 先抽特徵
 *   npx tsx scripts/backtest/ablation.ts verify|ablate|optimize|final
 *
 * 時間序切分（事先寫死，見 SPLITS）：樣本內 2024-10～2026-08 切成 訓練／驗證／測試，中間留空窗（≥20 個交易日）
 * 讓 20 日報酬不跨段重疊；樣本外 2022-01～2024-09（不同股票池）當第二個最終測試。
 * 消融與搜尋只看「訓練」；候選規則用「驗證」挑一個；「測試＋樣本外」只在 final 跑一次。
 * 上線條件（事先寫死，PASS_RULE）：測試與樣本外的建議買進 20 日超額都 ≥ 現行、NW t 不低於現行、翻轉次數 ≤ 現行 ×1.15。
 */
import fs from "node:fs";
import path from "node:path";
import { applyRatingConfirmation, type ConfirmState } from "@/lib/ai/ratingStability";
import type { HoldingCode, RatingCode } from "@/lib/ai/siteRating";
import { PE_CHEAP, PE_EXPENSIVE, YIELD_GOOD } from "@/lib/ai/actionScoring";
import { WEAK_MARKET_RET60_PCT, CONFIDENCE_HIGH_MIN_STREAK } from "@/lib/ai/siteRating";
import { ABLATION_OUT_DIR, FAMILIES, type Family, type FeatRow } from "./ablationData";
import { IS, OOS } from "./regimeConfig";
import { revenueYoyAsOf, weeklySignalDates } from "./wideData";

// ───────────── 切分（事先寫死） ─────────────
export const SPLITS = {
  train: { period: "is", from: "2024-10-01", to: "2025-06-30" },
  val: { period: "is", from: "2025-08-01", to: "2026-01-31" },
  test: { period: "is", from: "2026-03-09", to: "2026-08-31" },
  oos: { period: "oos", from: "2022-01-01", to: "2024-09-30" },
} as const;
type SplitKey = keyof typeof SPLITS;

// ───────────── 規則設定 ─────────────
export interface Cfg {
  /** 各技術訊號家族計入多方／空方的權重（現行全部 1） */
  up: Record<Family, number>;
  dn: Record<Family, number>;
  /** 漲多警訊（RSI 超買、布林上緣）算不算多方（現行不算） */
  ohAsBull: number;
  /** 技術面支持：多方加權 ≥ techMinBull 且 空方加權 ≤ techMaxBear；不支持：空方 > 多方 */
  techMinBull: number;
  techMaxBear: number;
  techVeto: boolean;
  /** 籌碼面：近 N 日三大法人累計，>門檻（占 20 日均量 %）＝支持，< −門檻＝不支持 */
  chipsN: 1 | 3 | 5 | 10;
  chipsPct: number;
  chipsVeto: boolean;
  useRevenue: boolean;
  useValuation: boolean;
  /** 加權分數版（null＝現行「支持數門檻」版）：分數＝Σ 面向權重 × (+1 支持／−1 不支持)，≥ theta 才買 */
  weights: null | { tech: number; chips: number; rev: number; val: number; theta: number };
  minSupport: number;
  maxAgainst: number;
  /** 追高防護當一票否決的（現行只有 surge 當提示、不否決） */
  vetoGuards: string[];
  brokeVeto: boolean;
  confirm: boolean;
  /** 弱市況（60 日報酬 < 門檻）時不買 */
  weakVeto: number | null;
  /** 只在把握程度「高」（非弱市＋連續≥N天）時才算買進（null＝不限） */
  confOnly: number | null;
}

const ones = () => Object.fromEntries(FAMILIES.map((f) => [f, 1])) as Record<Family, number>;
export const BASE: Cfg = {
  up: ones(), dn: ones(), ohAsBull: 0, techMinBull: 2, techMaxBear: 0, techVeto: true,
  chipsN: 1, chipsPct: 0, chipsVeto: true, useRevenue: false, useValuation: false, weights: null,
  minSupport: 2, maxAgainst: 1, vetoGuards: [], brokeVeto: true, confirm: true, weakVeto: null, confOnly: null,
};

// ───────────── 外部資料（月營收、本益比），一律「訊號日當時已公布」 ─────────────
interface Ext { rev: number | null; pe: number | null; dy: number | null }
const perCache = new Map<string, { date: string; pe: number; dy: number }[] | null>();
const revCache = new Map<string, Map<string, number> | null>();
function perRows(period: string, sym: string) {
  const k = `${period}|${sym}`;
  if (!perCache.has(k)) {
    const fn = path.join(period === "oos" ? OOS.cacheDir : IS.cacheDir, "fm-per", `${sym}.json`);
    perCache.set(k, fs.existsSync(fn) ? (JSON.parse(fs.readFileSync(fn, "utf8")).rows as { date: string; pe: number; dy: number }[]) : null);
  }
  return perCache.get(k)!;
}
function fmRevYoy(sym: string): Map<string, number> | null {
  if (!revCache.has(sym)) {
    const fn = path.join(OOS.cacheDir, "fm-revenue", `${sym}.json`);
    if (!fs.existsSync(fn)) revCache.set(sym, null);
    else {
      const rows = JSON.parse(fs.readFileSync(fn, "utf8")).rows as { y: number; m: number; rev: number }[];
      const by = new Map(rows.map((r) => [`${r.y}-${r.m}`, r.rev]));
      const out = new Map<string, number>();
      for (const r of rows) {
        const prev = by.get(`${r.y - 1}-${r.m}`);
        if (prev && prev > 0) out.set(`${r.y}-${r.m}`, (r.rev / prev - 1) * 100);
      }
      revCache.set(sym, out);
    }
  }
  return revCache.get(sym)!;
}
/** 樣本外月營收：法定次月 10 日前公布 → 訊號日 ≥ 次月 11 日才用（跟 wideData.revenueYoyAsOf 同一個規則）。 */
function oosRevAsOf(date: string, sym: string): number | null {
  const m = fmRevYoy(sym);
  if (!m) return null;
  const [Y, M, D] = date.split("-").map(Number);
  let y = Y, mm = M - (D >= 11 ? 1 : 2);
  while (mm <= 0) { mm += 12; y--; }
  return m.get(`${y}-${mm}`) ?? null;
}
function extFor(period: string, r: FeatRow): Ext {
  const rev = period === "oos" ? oosRevAsOf(r.d, r.s) : revenueYoyAsOf(r.d, r.s);
  const pr = perRows(period, r.s);
  let pe: number | null = null, dy: number | null = null;
  if (pr) {
    // 最後一筆 date ≤ 訊號日（二分）
    let lo = 0, hi = pr.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (pr[mid].date <= r.d) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    if (k >= 0 && pr[k].date >= addDays(r.d, -7)) { pe = pr[k].pe; dy = pr[k].dy; }
  }
  return { rev, pe, dy };
}
function addDays(d: string, n: number) {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

// ───────────── 載入 ─────────────
interface Row extends FeatRow { ext: Ext; parsed: { f: Family | "OTHER"; tone: string; oh: boolean }[] }
const loaded = new Map<string, { rows: Row[]; bySym: Map<string, Row[]>; tierAvg: Map<string, number>; weekly: Set<string> }>();
function load(period: "is" | "oos") {
  if (loaded.has(period)) return loaded.get(period)!;
  const raw = JSON.parse(fs.readFileSync(path.join(ABLATION_OUT_DIR, `feat-${period}.json`), "utf8")) as FeatRow[];
  const rows: Row[] = raw.map((r) => ({
    ...r,
    ext: extFor(period, r),
    parsed: r.sig.map((s) => { const [f, tone, oh] = s.split(":"); return { f: f as Family, tone, oh: oh === "oh" }; }),
  }));
  const bySym = new Map<string, Row[]>();
  for (const r of rows) bySym.set(r.s, [...(bySym.get(r.s) ?? []), r]);
  const tierAvg = new Map<string, number>();
  for (const h of [10, 20] as const) {
    const acc = new Map<string, number[]>();
    for (const r of rows) { const v = h === 10 ? r.r10 : r.r20; if (v != null) { const k = `${r.d}|${r.t}|${h}`; (acc.get(k) ?? acc.set(k, []).get(k)!).push(v); } }
    for (const [k, v] of acc) tierAvg.set(k, v.reduce((a, b) => a + b, 0) / v.length);
  }
  const p = period === "oos" ? OOS : IS;
  const cal = [...new Set(rows.map((r) => r.d))].sort();
  const weekly = new Set(weeklySignalDates(cal, p.signalStart, p.signalEnd));
  const v = { rows, bySym, tierAvg, weekly };
  loaded.set(period, v);
  return v;
}

// ───────────── 規則重組 ─────────────
type V = "支持" | "中性" | "不支持" | "無資料";
function rawRating(c: Cfg, r: Row): { code: RatingCode; hold: HoldingCode; broke: boolean } {
  // 技術面
  let tech: V = "無資料", bull = 0, bear = 0;
  if (r.parsed.length > 0) {
    for (const s of r.parsed) {
      if (s.f === "OTHER") continue;
      if (s.tone === "up") bull += s.oh ? c.ohAsBull : c.up[s.f];
      else if (s.tone === "down") bear += c.dn[s.f];
    }
    tech = bull >= c.techMinBull && bear <= c.techMaxBear ? "支持" : bear > bull ? "不支持" : "中性";
  }
  // 籌碼面
  let chips: V = "無資料";
  const w = c.chipsN === 1 ? r.inst : c.chipsN === 3 ? r.w3 : c.chipsN === 5 ? r.w5 : r.w10;
  if (r.inst != null && w != null) {
    const th = c.chipsPct > 0 && r.vol20 > 0 ? (c.chipsPct / 100) * r.vol20 : 0;
    chips = w > th ? "支持" : w < -th ? "不支持" : "中性";
  }
  const facets: V[] = [tech, chips];
  let revV: V = "無資料", valV: V = "無資料";
  if (c.useRevenue && r.ext.rev != null) revV = r.ext.rev > 0 ? "支持" : r.ext.rev < 0 ? "不支持" : "中性";
  if (c.useValuation && (r.ext.pe != null || r.ext.dy != null)) {
    const pe = r.ext.pe && r.ext.pe > 0 ? r.ext.pe : null; // FinMind 虧損時 PER＝0
    valV = pe != null && pe > PE_EXPENSIVE ? "不支持" : (pe != null && pe <= PE_CHEAP) || (r.ext.dy ?? 0) >= YIELD_GOOD ? "支持" : "中性";
  }
  facets.push(revV, valV);
  const sup = facets.filter((f) => f === "支持").length;
  const ag = facets.filter((f) => f === "不支持").length;
  const guardVeto = c.vetoGuards.some((g) => r.guards.includes(g));
  let pass: boolean;
  if (c.weights) {
    const sc = (v: V) => (v === "支持" ? 1 : v === "不支持" ? -1 : 0);
    const s = c.weights.tech * sc(tech) + c.weights.chips * sc(chips) + c.weights.rev * sc(revV) + c.weights.val * sc(valV);
    pass = s >= c.weights.theta;
  } else pass = sup >= c.minSupport && ag <= c.maxAgainst;
  pass = pass && !(c.techVeto && tech === "不支持") && !(c.chipsVeto && chips === "不支持") && !guardVeto;
  if (pass && c.weakVeto != null && r.ret60 != null && r.ret60 < c.weakVeto) pass = false;
  const broke = r.broke;
  const code: RatingCode = pass && !(c.brokeVeto && broke) ? "buy" : "avoid";
  const hold: HoldingCode = code === "buy" ? "hold" : broke ? "exit" : ag >= 2 ? "reduce" : "hold";
  return { code, hold, broke };
}

/** 依規則算出每列公布的結論（含 2 日確認）與連續天數。 */
function rate(c: Cfg, period: "is" | "oos"): Map<Row, { code: RatingCode; streak: number }> {
  const { bySym } = load(period);
  const out = new Map<Row, { code: RatingCode; streak: number }>();
  for (const rs of bySym.values()) {
    let st: ConfirmState | null = null;
    let streak = 0, prevCode: RatingCode | null = null;
    for (const r of rs) {
      const raw = rawRating(c, r);
      let code: RatingCode;
      if (c.confirm) {
        st = applyRatingConfirmation(st, { code: raw.code, holdingCode: raw.hold, hardRisk: raw.broke, day: r.d });
        code = st.code;
        streak = st.streak ?? 1;
      } else {
        code = raw.code;
        streak = prevCode === code ? streak + 1 : 1;
      }
      prevCode = code;
      if (code === "buy" && c.confOnly != null) {
        const weak = r.ret60 != null && r.ret60 < WEAK_MARKET_RET60_PCT;
        if (weak || streak < c.confOnly) code = "avoid"; // 只改「是否列入買進名單」，不回寫確認狀態
      }
      out.set(r, { code, streak });
    }
  }
  return out;
}

// ───────────── 統計 ─────────────
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
function nwT(series: number[], h: number): number {
  const T = series.length, mu = mean(series);
  if (T < 4) return NaN;
  const L = Math.ceil(h / 5), dev = series.map((x) => x - mu);
  const g = (l: number) => dev.slice(l).reduce((a, x, k) => a + x * dev[k], 0) / T;
  let v = g(0);
  for (let l = 1; l <= L; l++) v += 2 * (1 - l / (L + 1)) * g(l);
  return v > 0 ? mu / Math.sqrt(v / T) : NaN;
}
export interface Stat { b10: number; t10: number; b20: number; t20: number; nB: number; a20: number; flips: number; share: number; d20: number; d10: number }
type Range = { period: "is" | "oos"; from: string; to: string };
/** 訓練集前後兩半（最佳化用「兩半都要變好」防過擬合） */
const TRAIN_HALVES: Range[] = [
  { period: "is", from: "2024-10-01", to: "2025-02-14" },
  { period: "is", from: "2025-02-15", to: "2025-06-30" },
];
const rateCache = new Map<string, Map<Row, { code: RatingCode; streak: number }>>();
function rateCached(c: Cfg, period: "is" | "oos") {
  const k = `${period}|${JSON.stringify(c)}`;
  if (!rateCache.has(k)) { if (rateCache.size > 40) rateCache.clear(); rateCache.set(k, rate(c, period)); }
  return rateCache.get(k)!;
}
function stats(c: Cfg, split: SplitKey | Range, pre?: Map<Row, { code: RatingCode; streak: number }>): Stat {
  const sp = typeof split === "string" ? SPLITS[split] : split;
  const period = sp.period;
  const { rows, tierAvg, weekly, bySym } = load(period);
  const rated = pre ?? rateCached(c, period);
  const inSplit = (r: Row) => r.d >= sp.from && r.d <= sp.to;
  const xt = (r: Row, h: 10 | 20) => { const v = h === 10 ? r.r10 : r.r20; return v == null ? null : v - tierAvg.get(`${r.d}|${r.t}|${h}`)!; };
  const series = (sel: Row[], h: 10 | 20) => {
    const by = new Map<string, number[]>();
    for (const r of sel) { const x = xt(r, h); if (x != null) (by.get(r.d) ?? by.set(r.d, []).get(r.d)!).push(x); }
    return { s: [...by.keys()].sort().map((d) => mean(by.get(d)!)), n: [...by.values()].reduce((a, b) => a + b.length, 0) };
  };
  const sel = rows.filter(inSplit);
  const wk = sel.filter((r) => weekly.has(r.d));
  const buysW = wk.filter((r) => rated.get(r)!.code === "buy");
  const avW = wk.filter((r) => rated.get(r)!.code !== "buy");
  const s10 = series(buysW, 10), s20 = series(buysW, 20), sa = series(avW, 20);
  const d20 = series(sel.filter((r) => rated.get(r)!.code === "buy"), 20);
  const d10 = series(sel.filter((r) => rated.get(r)!.code === "buy"), 10);
  let flips = 0, days = 0;
  for (const rs of bySym.values()) {
    let prev: boolean | null = null;
    for (const r of rs) {
      if (!inSplit(r)) { prev = null; continue; }
      const b = rated.get(r)!.code === "buy";
      days++;
      if (prev != null && prev !== b) flips++;
      prev = b;
    }
  }
  return {
    b10: mean(s10.s), t10: nwT(s10.s, 10), b20: mean(s20.s), t20: nwT(s20.s, 20), nB: s20.n,
    a20: mean(sa.s), flips: (flips / days) * 21, share: sel.filter((r) => rated.get(r)!.code === "buy").length / sel.length,
    d20: mean(d20.s), d10: mean(d10.s),
  };
}

const f2 = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(2)}` : "—");
const fmtStat = (s: Stat) =>
  `| ${f2(s.b10)}（${f2(s.t10)}） | ${f2(s.b20)}（${f2(s.t20)}） | ${s.nB} | ${f2(s.d20)} | ${f2(s.a20)} | ${s.flips.toFixed(2)} | ${(s.share * 100).toFixed(1)}% |`;
const HEADER = "| 變體 | 買進 10日超額（t） | 買進 20日超額（t） | 週取樣筆數 | 日頻 20日 | 先不要買 20日 | 翻轉/檔/月 | 買進占比 |\n|---|---|---|---:|---:|---:|---:|---:|";

// ───────────── 指令 ─────────────
function verify() {
  for (const period of ["is", "oos"] as const) {
    const { rows } = load(period);
    const rated = rate(BASE, period);
    let bad = 0;
    for (const r of rows) if ((rated.get(r)!.code === "buy") !== (r.code === "buy")) bad++;
    console.log(`${period}：${rows.length} 列，重組現行規則與正式 computeRatingCore 不一致 ${bad} 列`);
    const withRev = rows.filter((r) => r.ext.rev != null).length, withPe = rows.filter((r) => r.ext.pe != null).length;
    console.log(`  有月營收 ${((withRev / rows.length) * 100).toFixed(1)}%、有本益比 ${((withPe / rows.length) * 100).toFixed(1)}%`);
  }
}

const clone = (c: Cfg): Cfg => JSON.parse(JSON.stringify(c));
const mod = (fn: (c: Cfg) => void) => (base: Cfg) => { const c = clone(base); fn(c); return c; };

export const ABLATIONS: Array<[string, (b: Cfg) => Cfg]> = [
  ["拿掉技術面（技術面一律無資料）", mod((c) => { for (const f of FAMILIES) { c.up[f] = 0; c.dn[f] = 0; } c.techMinBull = 99; })],
  ["技術面不一票否決", mod((c) => { c.techVeto = false; })],
  ["技術面支持門檻 多方≥1", mod((c) => { c.techMinBull = 1; })],
  ["技術面支持門檻 多方≥3", mod((c) => { c.techMinBull = 3; })],
  ["技術面支持容許 1 個空方", mod((c) => { c.techMaxBear = 1; })],
  ["漲多警訊算多方", mod((c) => { c.ohAsBull = 1; })],
  ...FAMILIES.flatMap((f): Array<[string, (b: Cfg) => Cfg]> => [
    [`拿掉訊號 ${f}（多空都不計）`, mod((c) => { c.up[f] = 0; c.dn[f] = 0; })],
    [`${f} 多方權重 ×2`, mod((c) => { c.up[f] = 2; })],
    [`${f} 空方不計`, mod((c) => { c.dn[f] = 0; })],
  ]),
  ["拿掉籌碼面", mod((c) => { c.chipsN = 1; c.chipsPct = 1e9; c.chipsVeto = false; })],
  ["籌碼面不一票否決", mod((c) => { c.chipsVeto = false; })],
  ["籌碼面看 3 日累計", mod((c) => { c.chipsN = 3; })],
  ["籌碼面看 5 日累計", mod((c) => { c.chipsN = 5; })],
  ["籌碼面看 10 日累計", mod((c) => { c.chipsN = 10; })],
  ["籌碼面門檻 ±5% 均量", mod((c) => { c.chipsPct = 5; })],
  ["籌碼面門檻 ±10% 均量", mod((c) => { c.chipsPct = 10; })],
  ["加入財報面（月營收年增）", mod((c) => { c.useRevenue = true; })],
  ["加入基本面（本益比／殖利率）", mod((c) => { c.useValuation = true; })],
  ["加入財報＋基本面", mod((c) => { c.useRevenue = true; c.useValuation = true; })],
  ["支持門檻 ≥1 項", mod((c) => { c.minSupport = 1; })],
  ["不支持上限 0 項", mod((c) => { c.maxAgainst = 0; })],
  ["破底不否決", mod((c) => { c.brokeVeto = false; })],
  ["追高否決：RSI≥75", mod((c) => { c.vetoGuards = ["rsi"]; })],
  ["追高否決：急漲 surge", mod((c) => { c.vetoGuards = ["surge"]; })],
  ["追高否決：乖離 bias", mod((c) => { c.vetoGuards = ["bias"]; })],
  ["追高否決：外資大賣 foreignSell", mod((c) => { c.vetoGuards = ["foreignSell"]; })],
  ["拿掉連 2 日確認", mod((c) => { c.confirm = false; })],
  ["弱市況（60日<+5%）不買", mod((c) => { c.weakVeto = WEAK_MARKET_RET60_PCT; })],
  ["弱市況（60日<0%）不買", mod((c) => { c.weakVeto = 0; })],
  [`只買把握程度高（非弱市＋連續≥${CONFIDENCE_HIGH_MIN_STREAK}）`, mod((c) => { c.confOnly = CONFIDENCE_HIGH_MIN_STREAK; })],
  ["只買 非弱市＋連續≥2", mod((c) => { c.confOnly = 2; })],
  ["只買 非弱市＋連續≥5", mod((c) => { c.confOnly = 5; })],
];

function ablate(base: Cfg, label: string, split: SplitKey = "train") {
  const head = HEADER.split("\n");
  console.log(`\n### 消融（${label}；${split} ${SPLITS[split].from}～${SPLITS[split].to}）\n\n${head[0]} 前半／後半 日頻20日 | 判定 |\n${head[1]}---|---|`);
  const b = stats(base, split);
  const hs = (c: Cfg) => TRAIN_HALVES.map((h) => stats(c, h).d20);
  const bh = hs(base);
  console.log(`| **基準** ${fmtStat(b)} ${bh.map(f2).join("／")} | — |`);
  const res: Array<[string, Stat, number[], string]> = [];
  for (const [name, fn] of ABLATIONS) {
    const c = fn(base);
    const s = stats(c, split);
    const h = hs(c);
    const d = h.map((x, i) => x - bh[i]);
    // 判定：訓練集前後兩半「日頻 20 日超額」同向且都 ≥0.1 個百分點 → 改了變好；都 ≤ −0.1 → 改了變差；其餘＝無明確影響
    const verdict = !(s.share > 0.01) ? "買進幾乎消失" : d.every((x) => x >= 0.1) ? "改了變好" : d.every((x) => x <= -0.1) ? "改了變差" : "無明確影響";
    res.push([name, s, h, verdict]);
    console.log(`| ${name} ${fmtStat(s)} ${h.map(f2).join("／")} | ${verdict} |`);
  }
  fs.writeFileSync(path.join(ABLATION_OUT_DIR, `ablate-${label}-${split}.json`), JSON.stringify({ base: b, res }));
}

// ───────────── 最佳化：在訓練集做座標下降，驗證集挑選 ─────────────
type Knob = { name: string; values: unknown[]; get: (c: Cfg) => unknown; set: (c: Cfg, v: unknown) => void };
function knobs(withExt: boolean): Knob[] {
  const k: Knob[] = [
    { name: "techMinBull", values: [1, 1.5, 2, 3], get: (c) => c.techMinBull, set: (c, v) => (c.techMinBull = v as number) },
    { name: "techMaxBear", values: [0, 1], get: (c) => c.techMaxBear, set: (c, v) => (c.techMaxBear = v as number) },
    { name: "ohAsBull", values: [0, 0.5, 1], get: (c) => c.ohAsBull, set: (c, v) => (c.ohAsBull = v as number) },
    ...FAMILIES.map((f): Knob => ({ name: `up.${f}`, values: [0, 0.5, 1, 1.5], get: (c) => c.up[f], set: (c, v) => (c.up[f] = v as number) })),
    ...FAMILIES.map((f): Knob => ({ name: `dn.${f}`, values: [0, 1, 2], get: (c) => c.dn[f], set: (c, v) => (c.dn[f] = v as number) })),
    { name: "chipsN", values: [1, 3, 5, 10], get: (c) => c.chipsN, set: (c, v) => (c.chipsN = v as Cfg["chipsN"]) },
    { name: "chipsPct", values: [0, 5, 10], get: (c) => c.chipsPct, set: (c, v) => (c.chipsPct = v as number) },
    { name: "vetoGuards", values: [[], ["rsi"], ["bias"], ["foreignSell"]], get: (c) => JSON.stringify(c.vetoGuards), set: (c, v) => (c.vetoGuards = v as string[]) },
  ];
  if (withExt)
    k.push(
      { name: "weights.rev", values: [0, 0.5, 1], get: (c) => c.weights!.rev, set: (c, v) => (c.weights!.rev = v as number) },
      { name: "weights.val", values: [0, 0.5, 1], get: (c) => c.weights!.val, set: (c, v) => (c.weights!.val = v as number) },
      { name: "weights.theta", values: [1, 1.5, 2, 2.5], get: (c) => c.weights!.theta, set: (c, v) => (c.weights!.theta = v as number) }
    );
  return k;
}
/**
 * 訓練目標（防過擬合）：訓練集切前後兩半，各算「建議買進 日頻 20 日超額 ＋ 0.5×日頻 10 日超額」；
 * 一個改動要被接受，必須「兩半都改善」且較差那一半至少改善 MIN_GAIN 個百分點（只在一半變好＝多半是雜訊）。
 * 硬限制：整段訓練集買進占比 ≥8%、翻轉次數 ≤ 起點 ×1.15。
 */
const MIN_GAIN = 0.05;
function halves(c: Cfg): number[] | null {
  const full = stats(c, "train");
  if (!(full.share >= 0.08) || full.flips > baseFlips * 1.15) return null;
  return TRAIN_HALVES.map((h) => { const s = stats(c, h); return s.d20 + 0.5 * s.d10; });
}
let baseFlips = Infinity;
function optimize(start: Cfg, withExt: boolean, tag: string) {
  baseFlips = stats(BASE, "train").flips;
  let cur = clone(start);
  let curH = halves(cur) ?? [-Infinity, -Infinity];
  const trail: Array<{ cfg: Cfg; obj: number[]; step: string }> = [{ cfg: clone(cur), obj: curH, step: "起點" }];
  const ks = knobs(withExt);
  console.log(`  ${tag} 起點 兩半目標 ${curH.map((x) => x.toFixed(3)).join("／")}`);
  for (let round = 1; round <= 3; round++) {
    let improved = false;
    for (const k of ks) {
      let best: { v: unknown; h: number[]; gain: number } | null = null;
      for (const v of k.values) {
        if (JSON.stringify(v) === JSON.stringify(k.get(cur))) continue;
        const c = clone(cur);
        k.set(c, v);
        const h = halves(c);
        if (!h) continue;
        const gain = Math.min(...h.map((x, i) => x - curH[i]));
        if (gain >= MIN_GAIN && (!best || gain > best.gain)) best = { v, h, gain };
      }
      if (best) {
        k.set(cur, best.v);
        curH = best.h;
        improved = true;
        trail.push({ cfg: clone(cur), obj: curH, step: `第${round}輪 ${k.name}=${JSON.stringify(best.v)}` });
        console.log(`  ${tag} 第${round}輪 ${k.name}=${JSON.stringify(best.v)} → 兩半目標 ${curH.map((x) => x.toFixed(3)).join("／")}`);
      }
    }
    if (!improved) break;
  }
  fs.writeFileSync(path.join(ABLATION_OUT_DIR, `opt-${tag}.json`), JSON.stringify(trail));
  return trail;
}

function runOptimize() {
  const withExtStart: Cfg = { ...clone(BASE), useRevenue: true, useValuation: true, weights: { tech: 1, chips: 1, rev: 1, val: 1, theta: 2 } };
  const tracks = [
    { tag: "門檻版", trail: optimize(BASE, false, "門檻版") },
    { tag: "加權版", trail: optimize(withExtStart, true, "加權版") },
  ];
  // 驗證集挑選：每條軌跡的每個中間點都是候選（含起點＝現行），取驗證集 20 日週取樣超額最高者；
  // 但 t 必須 ≥ 現行驗證 t − 0.3、翻轉 ≤ 現行 ×1.15。
  const baseVal = stats(BASE, "val");
  console.log(`\n### 驗證集挑選（${SPLITS.val.from}～${SPLITS.val.to}）\n\n${HEADER}`);
  console.log(`| 現行 ${fmtStat(baseVal)}`);
  let pick: { name: string; cfg: Cfg; s: Stat } = { name: "現行", cfg: BASE, s: baseVal };
  for (const tr of tracks)
    for (const p of tr.trail) {
      const s = stats(p.cfg, "val");
      console.log(`| ${tr.tag}：${p.step} ${fmtStat(s)}`);
      if (s.b20 > pick.s.b20 && s.t20 >= baseVal.t20 - 0.3 && s.flips <= baseVal.flips * 1.15) pick = { name: `${tr.tag}：${p.step}`, cfg: p.cfg, s };
    }
  console.log(`\n驗證集選中：${pick.name}`);
  fs.writeFileSync(path.join(ABLATION_OUT_DIR, "picked.json"), JSON.stringify(pick));
}

/** 最終測試（只跑一次）：測試集＋樣本外，現行 vs 選中規則。 */
function final() {
  const pick = JSON.parse(fs.readFileSync(path.join(ABLATION_OUT_DIR, "picked.json"), "utf8")) as { name: string; cfg: Cfg };
  console.log(`\n### 最終測試：現行 vs 「${pick.name}」\n\n${HEADER.replace("| 變體 |", "| 段／規則 |")}`);
  const out: Record<string, { cur: Stat; new: Stat }> = {};
  for (const sp of ["train", "val", "test", "oos"] as const) {
    const a = stats(BASE, sp), b = stats(pick.cfg, sp);
    out[sp] = { cur: a, new: b };
    console.log(`| ${sp} 現行 ${fmtStat(a)}`);
    console.log(`| ${sp} 新規則 ${fmtStat(b)}`);
  }
  const ok = (sp: "test" | "oos") => out[sp].new.b20 >= out[sp].cur.b20 && out[sp].new.t20 >= out[sp].cur.t20 && out[sp].new.flips <= out[sp].cur.flips * 1.15;
  console.log(`\n上線條件：測試 ${ok("test") ? "通過" : "不通過"}、樣本外 ${ok("oos") ? "通過" : "不通過"} → ${ok("test") && ok("oos") ? "可上線" : "不上線"}`);
  fs.writeFileSync(path.join(ABLATION_OUT_DIR, "final.json"), JSON.stringify({ pick, out }));
}

const cmd = process.argv[2];
if (cmd === "verify") verify();
if (cmd === "ablate") {
  ablate(BASE, "現行");
  ablate({ ...clone(BASE), useRevenue: true, useValuation: true }, "現行＋財報基本面");
}
if (cmd === "optimize") runOptimize();
if (cmd === "final") final();
if (cmd === "stat") for (const sp of ["train", "val", "test", "oos"] as const) console.log(sp, fmtStat(stats(BASE, sp)));
