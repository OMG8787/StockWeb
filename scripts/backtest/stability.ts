/**
 * 評等穩定化回測（2026-10-06 使用者回報：「昨天建議我賣我才賣、建議我買我才買，今天又不一樣」）。
 *   npx tsx scripts/backtest/dailyChipsFetch.ts is|oos   # 先下載每日三大法人（FinMind，可續傳）
 *   npx tsx scripts/backtest/stability.ts [is|oos|both]
 *
 * 問題：評等的籌碼面＝三大法人「單日」買賣超正負號，且籌碼面不支持＝一票不買；單日法人方向很像擲硬幣，
 * 評等因此天天翻。這裡「每個交易日」都用正式評等核心 computeRatingCore() 算一次，比較幾種事先定好的改法：
 *   - 籌碼面看近 N 日累計（N＝1 現行、3、5、10）
 *   - 翻轉需連續 2 個交易日確認（破底＝硬性風險訊號立即生效）
 * 指標：①每檔每月評等翻轉次數（建議買進⇄先不要買；持有建議大類 續抱／減碼／出場）；
 *       ②每週最後一個交易日的評等 → 隔日開盤進場、10／20 日超額（減同日同市值層級平均），Newey-West t 值
 *         （跟 wide.ts 同一套方法，基準可比）；另列「每天都評等」的日頻超額（樣本大、但同一檔相鄰日高度重疊）。
 * 上線條件（事先定好）：超額不變差（點估計不低於現行、t 不下降超過 0.3）且翻轉次數下降 ≥30%，樣本內外都要成立。
 */
import type { Candle, Chips } from "@/lib/data/types";
import { computeRatingCore } from "@/lib/ai/ratingCore";
import type { ConfirmState } from "@/lib/ai/ratingStability";
import { sumChipsWindow, type ChipsDayRow } from "@/lib/ai/chipsWindow";
import { ACTIVE_CHASE_GUARDS } from "@/lib/ai/chaseGuards";
import type { HoldingCode, RatingCode, SiteRating } from "@/lib/ai/siteRating";
import fs from "node:fs";
import path from "node:path";
import { weeklySignalDates, type Tier } from "./wideData";
import { IS, OOS, type PeriodConfig } from "./regimeConfig";
import { buildUniverseFor, loadCandlesFor } from "./regimeData";

const HS = [10, 20] as const;
type H = (typeof HS)[number];
const CHIPS_NS = [1, 3, 5, 10] as const;

interface DayChips { date: string; inst: number; foreign: number; trust: number }

function loadDailyChips(p: PeriodConfig, sym: string): DayChips[] | null {
  const fn = path.join(p.cacheDir, "daily-chips", `${sym}.json`);
  if (!fs.existsSync(fn)) return null;
  const d = JSON.parse(fs.readFileSync(fn, "utf8")) as { rows: DayChips[] };
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
  hold: HoldingCode;
  hard: boolean;
  chipsVerdict: string;
  techVerdict: string;
  ret: Record<H, number | null>;
  /** 把握程度研究用（--conf）：評等當下的條件 */
  rating?: SiteRating;
  bull?: number;
  streak?: number;
}

type Variant = { key: string; n: (typeof CHIPS_NS)[number]; confirm: boolean };
const VARIANTS: Variant[] = [
  ...CHIPS_NS.map((n) => ({ key: `籌碼${n}日${n === 1 ? "（現行）" : ""}`, n, confirm: false })),
  ...CHIPS_NS.map((n) => ({ key: `籌碼${n}日＋2日確認`, n, confirm: true })),
];

const holdClass = (h: HoldingCode) => (h === "add" || h === "hold" ? "keep" : h);

function run(p: PeriodConfig) {
  const { universe } = buildUniverseFor(p);
  const cal = loadCandlesFor(p, "2330")!.map((c) => c.time).filter((d) => d >= p.signalStart && d <= p.signalEnd);
  const weekly = new Set(weeklySignalDates(cal, p.signalStart, p.signalEnd));
  const twii = loadCandlesFor(p, "_TWII");
  const ret60 = new Map<string, number>();
  if (twii) twii.forEach((c, k) => k >= 60 && ret60.set(c.time, (c.close / twii[k - 60].close - 1) * 100));
  // 每個變體：sym → 每日觀測
  const obs = new Map<string, Obs[]>(VARIANTS.map((v) => [v.key, []]));
  let used = 0;
  for (const u of universe) {
    const cs = loadCandlesFor(p, u.sym);
    const dc = loadDailyChips(p, u.sym);
    if (!cs || !dc) continue;
    used++;
    const cIdx = new Map(cs.map((c, i) => [c.time, i]));
    const chipDates = dc.map((r) => r.date);
    const dayRows: ChipsDayRow[] = dc.map((r) => ({ date: r.date, foreign: r.foreign, trust: r.trust, dealer: r.inst - r.foreign - r.trust }));
    let j = -1; // dc 中 ≤ date 的最後一筆
    const states = new Map<string, ConfirmState | null>(VARIANTS.map((v) => [v.key, null]));
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
      for (const v of VARIANTS) {
        // 正式評等核心（跟 stockRating.ts 同一個 computeRatingCore；累計籌碼與翻轉確認也是正式站同一套函式）。
        const core = computeRatingCore({
          symbol: u.sym, name: u.name, price: cs[i].close, market: "TW", candles: win, chaseCandles: hist, asOfDay: date, chips,
          chipsWindow: hasToday && v.n > 1 ? sumChipsWindow(dayRows.slice(0, j + 1), v.n) : null,
          guards: ACTIVE_CHASE_GUARDS,
          marketRet60Pct: ret60.get(date) ?? null,
          ...(v.confirm ? { confirmPrev: states.get(v.key)! } : {}),
        });
        if (v.confirm) states.set(v.key, core.rating.confirmState ?? null);
        obs.get(v.key)!.push({
          sym: u.sym, tier: u.tier, date, code: core.rating.code, hold: core.rating.holdingCode,
          hard: !!core.framework && !core.framework.zone,
          chipsVerdict: core.scored.facets[1].verdict, techVerdict: core.scored.facets[0].verdict,
          ret: { 10: fwd(cs, i, 10), 20: fwd(cs, i, 20) },
          rating: core.rating,
          bull: core.signals.filter((x) => x.tone === "up" && !/超買|布林通道上緣/.test(x.label)).length,
        });
      }
    }
  }

  // 同日同層級平均（用全部股票的 ret，與評等無關，所有變體共用）
  const base = obs.get(VARIANTS[0].key)!;
  const tierAvg = new Map<string, number>();
  for (const h of HS) {
    const acc = new Map<string, number[]>();
    for (const r of base) if (r.ret[h] != null) acc.set(`${r.date}|${r.tier}|${h}`, [...(acc.get(`${r.date}|${r.tier}|${h}`) ?? []), r.ret[h]!]);
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
  // 日頻：相鄰日重疊很重，NW 落後期數用持有日數（不是持有日/5）
  const statDaily = (sel: Obs[], h: H) => {
    const byDate = new Map<string, number[]>();
    for (const r of sel) {
      const x = xt(r, h);
      if (x != null) byDate.set(r.date, [...(byDate.get(r.date) ?? []), x]);
    }
    const series = [...byDate.keys()].sort().map((d) => mean(byDate.get(d)!));
    return { mean: mean(series), t: nwT(series, h * 5) };
  };

  const f = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(2)}` : "—");
  console.log(`\n## ${p.label}（${used} 檔有每日法人、${cal.length} 個交易日、${weekly.size} 週）\n`);
  console.log("| 變體 | 每檔每月翻轉：買⇄不買 | 持有建議大類 | 建議買進 10日超額（t） | 20日超額（t） | 先不要買 10日（t） | 20日（t） | 日頻 買進 10日（t） | 買進占比 |");
  console.log("|---|---:|---:|---|---|---|---|---|---:|");
  const flipSummary: Record<string, number> = {};
  for (const v of VARIANTS) {
    const all = obs.get(v.key)!;
    let flips = 0, hflips = 0, days = 0;
    const bySym = new Map<string, Obs[]>();
    for (const r of all) bySym.set(r.sym, [...(bySym.get(r.sym) ?? []), r]);
    for (const rs of bySym.values()) {
      days += rs.length;
      for (let k = 1; k < rs.length; k++) {
        if ((rs[k].code === "buy") !== (rs[k - 1].code === "buy")) flips++;
        if (holdClass(rs[k].hold) !== holdClass(rs[k - 1].hold)) hflips++;
      }
    }
    const perMonth = (x: number) => (x / days) * 21;
    flipSummary[v.key] = perMonth(flips);
    const wk = all.filter((r) => weekly.has(r.date));
    const b10 = statOf(wk.filter((r) => r.code === "buy"), 10), b20 = statOf(wk.filter((r) => r.code === "buy"), 20);
    const a10 = statOf(wk.filter((r) => r.code === "avoid"), 10), a20 = statOf(wk.filter((r) => r.code === "avoid"), 20);
    const d10 = statDaily(all.filter((r) => r.code === "buy"), 10);
    const share = all.filter((r) => r.code === "buy").length / all.length;
    console.log(
      `| ${v.key} | ${perMonth(flips).toFixed(2)} | ${perMonth(hflips).toFixed(2)} | ${f(b10.mean)}（${f(b10.t)}，${b10.n}筆） | ${f(b20.mean)}（${f(b20.t)}） | ${f(a10.mean)}（${f(a10.t)}） | ${f(a20.mean)}（${f(a20.t)}） | ${f(d10.mean)}（${f(d10.t)}） | ${(share * 100).toFixed(1)}% |`
    );
  }
  if (process.argv.includes("--conf")) confAnalysis(obs.get("籌碼1日＋2日確認")!, weekly, xt, statOf, f);
  // 現行的翻轉主因：翻轉當天哪個面向也翻了
  const cur = obs.get(VARIANTS[0].key)!;
  const bySym = new Map<string, Obs[]>();
  for (const r of cur) bySym.set(r.sym, [...(bySym.get(r.sym) ?? []), r]);
  let total = 0, chipsFlip = 0, techFlip = 0, both = 0;
  for (const rs of bySym.values())
    for (let k = 1; k < rs.length; k++) {
      if ((rs[k].code === "buy") === (rs[k - 1].code === "buy")) continue;
      total++;
      const c = rs[k].chipsVerdict !== rs[k - 1].chipsVerdict, t = rs[k].techVerdict !== rs[k - 1].techVerdict;
      if (c) chipsFlip++;
      if (t) techFlip++;
      if (c && t) both++;
    }
  console.log(`\n現行翻轉 ${total} 次：當天籌碼面也翻 ${((chipsFlip / total) * 100).toFixed(0)}%、技術面也翻 ${((techFlip / total) * 100).toFixed(0)}%（兩者都翻 ${((both / total) * 100).toFixed(0)}%）`);
}

/** 把握程度研究：建議買進列依各條件分組的 10／20 日超額（每週取樣，NW t）。 */
function confAnalysis(
  all: Obs[],
  weekly: Set<string>,
  xt: (r: Obs, h: H) => number | null,
  statOf: (sel: Obs[], h: H) => { n: number; mean: number; t: number },
  f: (x: number) => string
) {
  // 連續同結論天數
  const bySym = new Map<string, Obs[]>();
  for (const r of all) bySym.set(r.sym, [...(bySym.get(r.sym) ?? []), r]);
  for (const rs of bySym.values()) rs.forEach((r, k) => (r.streak = k > 0 && rs[k - 1].code === r.code ? rs[k - 1].streak! + 1 : 1));
  const buys = all.filter((r) => r.code === "buy" && weekly.has(r.date));
  const d2 = (r: Obs) => (r.rating!.marketNote ? 0 : 1) + ((r.streak ?? 0) >= 3 ? 1 : 0) + ((r.streak ?? 0) >= 10 ? 1 : 0);
  const groups: Array<[string, (r: Obs) => boolean]> = [
    ["全部建議買進", () => true],
    ["待確認中（pendingChange）", (r) => !!r.rating!.pendingChange],
    ["現價偏高（附拉回加碼價）", (r) => r.rating!.pullbackAdd != null],
    ["接近支撐（無拉回加碼價）", (r) => r.rating!.pullbackAdd == null],
    ["短線風險（急漲）", (r) => !!r.rating!.riskNote],
    ["弱市況提示", (r) => !!r.rating!.marketNote],
    ["非弱市況", (r) => !r.rating!.marketNote],
    ["多方訊號 2 個", (r) => r.bull === 2],
    ["多方訊號 ≥3 個", (r) => (r.bull ?? 0) >= 3],
    ["連續同結論 1～2 天（剛轉買）", (r) => (r.streak ?? 0) <= 2],
    ["連續同結論 3～9 天", (r) => (r.streak ?? 0) >= 3 && (r.streak ?? 0) < 10],
    ["連續同結論 ≥10 天", (r) => (r.streak ?? 0) >= 10],
    ["D1 高：非弱市況且連續≥3天", (r) => !r.rating!.marketNote && (r.streak ?? 0) >= 3],
    ["D1 中：其餘", (r) => !(!r.rating!.marketNote && (r.streak ?? 0) >= 3) && !(!!r.rating!.marketNote && (r.streak ?? 0) <= 2)],
    ["D1 低：弱市況且剛轉買（≤2天）", (r) => !!r.rating!.marketNote && (r.streak ?? 0) <= 2],
    ["D2 分數2～3（非弱市況＋連續≥3＋連續≥10）", (r) => d2(r) >= 2],
    ["D2 分數1", (r) => d2(r) === 1],
    ["D2 分數0", (r) => d2(r) === 0],
  ];
  console.log("\n### 把握程度研究（採用版：單日籌碼＋2日確認；建議買進、每週取樣）\n");
  console.log("| 條件 | 筆數 | 10日超額（t） | 20日超額（t） |");
  console.log("|---|---:|---|---|");
  for (const [name, fn] of groups) {
    const sel = buys.filter(fn);
    const a = statOf(sel, 10), b = statOf(sel, 20);
    console.log(`| ${name} | ${a.n} | ${f(a.mean)}（${f(a.t)}） | ${f(b.mean)}（${f(b.t)}） |`);
  }
  const lv = process.env.CONF_FN ? null : null;
  void lv; void xt;
}

const which = process.argv[2] ?? "is";
if (which === "is" || which === "both") run(IS);
if (which === "oos" || which === "both") run(OOS);
