/**
 * 本站綜合評等回測（2026-10-05 檢討建立；之後每次調評等規則／門檻都要先跑）：
 *   npx tsx scripts/backtest/fetch.ts   # 先補資料（只抓快取沒有的）
 *   npx tsx scripts/backtest/run.ts     # 輸出統計表
 *   npx tsx scripts/backtest/run.ts --wide  # 擴大樣本（200 檔、約 2 年；先跑 wideFetch.ts），見 wide.ts
 *
 * 做法：對 config.ts 的股票池 × 訊號日，用「訊號日當天收盤為止」的日K與當日三大法人，
 * 直接呼叫正式評等核心 computeRatingCore()（src/lib/ai/ratingCore.ts，跟 stockRating.ts 同一個），隔一個交易日開盤進場，
 * 看 5／10 日報酬；「超額」＝減掉同一訊號日全樣本平均（扣掉大盤漲跌）。
 *
 * 限制（判讀時要記得）：
 * - 歷史的基本面（本益比）、財報、持股結構、新聞拿不到，一律當「無資料」——所以「建議買進」
 *   在這裡等於「技術面支持＋籌碼面支持」，比正式站少了三個面向；結論只能看相對好壞。
 * - 樣本只有 16 個訊號日、單一段多頭行情，數字是方向參考，不是統計顯著。
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, Chips } from "@/lib/data/types";
import { computeRatingCore } from "@/lib/ai/ratingCore";
import type { RatingCode } from "@/lib/ai/siteRating";
import { ACTIVE_CHASE_GUARDS, ALL_CHASE_GUARDS, evaluateChaseGuards, type ChaseGuardId, type ChaseMetrics } from "@/lib/ai/chaseGuards";
import { CACHE_DIR, REVENUE_MONTHS, SIGNAL_DATES, UNIVERSE } from "./config";

interface Row {
  sym: string;
  date: string;
  m: ChaseMetrics;
  techSupport: boolean;
  chips: string;
  /** 各版本評等 */
  codes: Record<string, RatingCode>;
  zoneHigh: number | null;
  r5: number | null;
  r10: number | null;
  /** 等回檔：5 日內有沒有回到區間上緣，有的話從那個價位買到第 5 日收盤的報酬 */
  pullbackFill: number | null;
  /** 替代選股邏輯用（--alt） */
  ma20gt60: boolean | null;
  /** 三大法人連 3 日買超（訊號日＋前 2 個交易日；缺資料是 null） */
  inst3: boolean | null;
  /** 訊號日當時已公布的最新月營收年增率（%） */
  revYoy: number | null;
  x5?: number | null;
  x10?: number | null;
}

const GUARD_LABEL: Record<ChaseGuardId, string> = {
  rsi: "①RSI≥75",
  surge: "②急漲（5日>15%／10日>25%／漲停且20日>25%）",
  bias: "③乖離（MA20>10%／MA60>25%）",
  foreignSell: "④外資賣超≥均量3%",
};

/** 要比較的版本：名稱 → 套用哪些追高防護（第一個＝2026-10-05 上午版 siteRating，當基準；最後一個＝現行程式）。 */
const VARIANTS: Record<string, readonly ChaseGuardId[]> = {
  "基準（10/05版，無追高防護）": [],
  ...Object.fromEntries(ALL_CHASE_GUARDS.map((g) => [`＋${GUARD_LABEL[g]}`, [g]])),
  "＋①②": ["rsi", "surge"],
  "＋①②③": ["rsi", "surge", "bias"],
  "＋①②③④（全部）": ALL_CHASE_GUARDS,
  [`現行程式（${ACTIVE_CHASE_GUARDS.join("+") || "無"}）`]: ACTIVE_CHASE_GUARDS,
};

function loadT86(date: string): Map<string, Chips> {
  const fn = path.join(CACHE_DIR, "t86", `${date.replace(/-/g, "")}.json`);
  const out = new Map<string, Chips>();
  if (!fs.existsSync(fn)) return out;
  const d = JSON.parse(fs.readFileSync(fn, "utf8")) as { fields: string[]; data?: string[][] };
  const idx = (name: string) => d.fields.indexOf(name);
  const iF = idx("外陸資買賣超股數(不含外資自營商)");
  const iT = idx("投信買賣超股數");
  const iA = idx("三大法人買賣超股數");
  const num = (s: string) => Number(s.replace(/,/g, ""));
  for (const r of d.data ?? []) {
    out.set(r[0].trim(), { institutionalNetShares: num(r[iA]), foreignNetShares: num(r[iF]), trustNetShares: num(r[iT]) });
  }
  return out;
}

/** 公開資訊觀測站月營收彙總表（Big5 HTML）→ 代號 → 年增率%。 */
function loadRevenue(y: number, m: number): Map<string, number> {
  const fn = path.join(CACHE_DIR, "revenue", `${y}_${m}.html`);
  const out = new Map<string, number>();
  if (!fs.existsSync(fn)) return out;
  const html = new TextDecoder("big5").decode(fs.readFileSync(fn));
  for (const tr of html.split(/<tr/i)) {
    const cells = [...tr.matchAll(/<td[^>]*>([^<]*)<\/td>/gi)].map((x) => x[1].trim());
    if (cells.length >= 7 && /^\d{4}$/.test(cells[0])) {
      const yoy = Number(cells[6].replace(/,/g, ""));
      if (Number.isFinite(yoy)) out.set(cells[0], yoy);
    }
  }
  return out;
}

/** 訊號日當時已公布的最新月份（法定次月 10 日前公布 → 訊號日 ≥ 次月 11 日才可用）。 */
function revenueAsOf(date: string, revs: Map<string, Map<string, number>>): Map<string, number> | null {
  let best: Map<string, number> | null = null;
  for (const [y, m] of REVENUE_MONTHS) {
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    const avail = `${ny + 1911}-${String(nm).padStart(2, "0")}-11`;
    if (date >= avail) best = revs.get(`${y}_${m}`) ?? best;
  }
  return best;
}

function buildRows(): Row[] {
  const t86Cache = new Map<string, Map<string, Chips>>();
  const t86Of = (d: string) => {
    if (!t86Cache.has(d)) t86Cache.set(d, loadT86(d));
    return t86Cache.get(d)!;
  };
  const t86 = { get: (d: string) => t86Of(d) };
  const revs = new Map(REVENUE_MONTHS.map(([y, m]) => [`${y}_${m}`, loadRevenue(y, m)]));
  const rows: Row[] = [];
  for (const sym of UNIVERSE) {
    const fn = path.join(CACHE_DIR, "charts", `${sym}.json`);
    if (!fs.existsSync(fn)) continue;
    const cs = (JSON.parse(fs.readFileSync(fn, "utf8")) as { candles?: Candle[] }).candles;
    if (!cs) continue;
    for (const date of SIGNAL_DATES) {
      const i = cs.findIndex((c) => c.time === date);
      if (i < 63 || !cs[i + 1]) continue;
      const price = cs[i].close;
      const hist = cs.slice(0, i + 1);
      const win = hist.slice(-63); // 正式站評等用 3 個月日K
      const chips = t86.get(date)?.get(sym) ?? null;
      // 正式評等核心（src/lib/ai/ratingCore.ts，跟 stockRating.ts 同一個函式）；各追高防護組合逐一算。
      const coreInput = { symbol: sym, name: sym, price, market: "TW" as const, candles: win, chaseCandles: hist, asOfDay: date, chips };
      const base = computeRatingCore(coreInput);
      const { scored, framework } = base;
      const m = base.chase!;
      const codes: Record<string, RatingCode> = {};
      for (const [name, guards] of Object.entries(VARIANTS)) {
        codes[name] = computeRatingCore({ ...coreInput, guards }).rating.code;
      }
      const entry = cs[i + 1].open;
      const ret = (k: number) => (cs[i + k] ? (cs[i + k].close / entry - 1) * 100 : null);
      let pullbackFill: number | null = null;
      const zoneHigh = framework?.zone?.high ?? null;
      if (zoneHigh != null && cs[i + 5]) {
        for (let k = 1; k <= 5; k++) {
          if (cs[i + k].low <= zoneHigh) {
            const fill = Math.min(cs[i + k].open, zoneHigh);
            pullbackFill = (cs[i + 5].close / fill - 1) * 100;
            break;
          }
        }
      }
      const closes = hist.map((c) => c.close);
      const avg = (k: number) => closes.slice(-k).reduce((a, b) => a + b, 0) / k;
      const instDays = [cs[i], cs[i - 1], cs[i - 2]].map((c) => t86Of(c.time));
      const inst3 = instDays.every((d) => d.size > 0)
        ? instDays.every((d) => (d.get(sym)?.institutionalNetShares ?? 0) > 0)
        : null;
      rows.push({
        sym, date, m, codes, zoneHigh, pullbackFill,
        ma20gt60: closes.length >= 60 ? avg(20) > avg(60) : null,
        inst3,
        revYoy: revenueAsOf(date, revs)?.get(sym) ?? null,
        techSupport: scored.facets[0].verdict === "支持",
        chips: scored.facets[1].verdict,
        r5: ret(5), r10: ret(10),
      });
    }
  }
  // 超額報酬：減同一訊號日全樣本平均
  for (const date of SIGNAL_DATES) {
    const same = rows.filter((r) => r.date === date);
    const mean = (k: "r5" | "r10") => {
      const v = same.map((r) => r[k]).filter((x): x is number => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
    };
    const m5 = mean("r5"), m10 = mean("r10");
    for (const r of same) {
      r.x5 = r.r5 == null ? null : r.r5 - m5;
      r.x10 = r.r10 == null ? null : r.r10 - m10;
    }
  }
  return rows;
}

function stat(sel: Row[]): string {
  const v5 = sel.map((r) => r.x5).filter((x): x is number => x != null);
  const v10 = sel.map((r) => r.x10).filter((x): x is number => x != null);
  if (v5.length === 0) return "n=0";
  const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
  const win = v5.filter((x) => x > 0).length / v5.length;
  const sorted = [...v5].sort((a, b) => a - b);
  const f = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  return `n=${String(v5.length).padStart(3)}  5日超額 平均${f(avg(v5)).padStart(7)} 中位${f(sorted[Math.floor(v5.length / 2)]).padStart(7)} 跑贏${(win * 100).toFixed(0).padStart(3)}%  10日超額 平均${f(avg(v10)).padStart(7)}`;
}

function main() {
  const rows = buildRows();
  const line = (name: string, sel: Row[]) => console.log(`${name.padEnd(34, "　")} ${stat(sel)}`);
  console.log(`樣本 ${rows.length} 筆（${new Set(rows.map((r) => r.sym)).size} 檔 × ${new Set(rows.map((r) => r.date)).size} 個訊號日）；超額＝減同日全樣本平均\n`);

  console.log("【一、各版本「建議買進」組】");
  line("全樣本", rows);
  line("舊：技術支持＋籌碼不反對", rows.filter((r) => r.techSupport && r.chips !== "不支持"));
  const base = "基準（10/05版，無追高防護）";
  for (const name of Object.keys(VARIANTS)) line(name, rows.filter((r) => r.codes[name] === "buy"));

  console.log("\n【二、被各規則從基準「建議買進」移出的（越差代表擋得越對）】");
  for (const name of Object.keys(VARIANTS)) {
    if (name === base) continue;
    line(name, rows.filter((r) => r.codes[base] === "buy" && r.codes[name] !== "buy"));
  }

  console.log("\n【三、全樣本中觸發／未觸發各規則（不管評等，看規則本身有沒有鑑別力）】");
  for (const g of ALL_CHASE_GUARDS) {
    const hit = (r: Row) => evaluateChaseGuards(r.m, [g]).length > 0;
    line(`觸發 ${GUARD_LABEL[g]}`, rows.filter(hit));
    line(`未觸發 ${GUARD_LABEL[g]}`, rows.filter((r) => !hit(r)));
  }

  console.log("\n【三之二、基準「等回檔」組依規則分（看過熱股該不該從等回檔名單拿掉、改成不要買）】");
  const basePb = rows.filter((r) => r.codes[base] === "buy-on-pullback");
  line("基準等回檔 且 RSI≥75", basePb.filter((r) => (r.m.rsi ?? 0) >= 75));
  line("基準等回檔 且 RSI<75", basePb.filter((r) => (r.m.rsi ?? 0) < 75));
  for (const g of ["surge", "bias"] as ChaseGuardId[]) {
    const hit = (r: Row) => evaluateChaseGuards(r.m, [g]).length > 0;
    line(`基準等回檔 且 觸發${GUARD_LABEL[g]}`, basePb.filter(hit));
  }

  console.log("\n【三之三、規則的增量：只觸發其中一條的（看 ③ 在 ② 之外有沒有多擋到差的）】");
  const only = (a: ChaseGuardId, b: ChaseGuardId) => (r: Row) =>
    evaluateChaseGuards(r.m, [a]).length > 0 && evaluateChaseGuards(r.m, [b]).length === 0;
  line("全樣本 觸發③未觸發②", rows.filter(only("bias", "surge")));
  line("全樣本 觸發②未觸發③", rows.filter(only("surge", "bias")));

  console.log("\n【四、現行程式的三種結論】");
  const cur = Object.keys(VARIANTS).at(-1)!;
  for (const code of ["buy", "buy-on-pullback", "avoid"] as RatingCode[]) line(code, rows.filter((r) => r.codes[cur] === code));
  const pb = rows.filter((r) => r.codes[cur] === "buy-on-pullback" && r.zoneHigh != null && r.r5 != null);
  const filled = pb.filter((r) => r.pullbackFill != null);
  const avgFill = filled.length ? filled.reduce((a, r) => a + r.pullbackFill!, 0) / filled.length : NaN;
  console.log(
    `等回檔：5 日內回到區間上緣 ${filled.length}/${pb.length} 筆（${pb.length ? ((filled.length / pb.length) * 100).toFixed(0) : 0}%）；` +
      `回到區間才買、抱到第 5 日收盤的平均報酬（未扣大盤，近似）${avgFill.toFixed(2)}%`
  );
}

/**
 * 替代選股邏輯（2026-10-05 主 agent 要求探索「有沒有正超額」）：`npx tsx scripts/backtest/run.ts --alt`
 * 每條規則的門檻都是事先定好的一組數字，不調參；另做前後兩半期間（各 8 個訊號日）的簡單樣本外檢查。
 */
function alternatives(rows: Row[]) {
  const line = (name: string, sel: Row[]) => console.log(`${name.padEnd(40, "　")} ${stat(sel)}`);
  // ② 需要「同日 20 日報酬排名前 30%」
  const top30 = new Set<Row>();
  for (const date of SIGNAL_DATES) {
    const same = rows.filter((r) => r.date === date && r.m.ret20 != null).sort((a, b) => b.m.ret20! - a.m.ret20!);
    same.slice(0, Math.ceil(same.length * 0.3)).forEach((r) => top30.add(r));
  }
  const ALT: Record<string, (r: Row) => boolean> = {
    "①多頭回檔（MA20>MA60、距MA20±3%、RSI40～55）": (r) =>
      r.ma20gt60 === true && r.m.ma20BiasPct != null && Math.abs(r.m.ma20BiasPct) <= 3 && r.m.rsi != null && r.m.rsi >= 40 && r.m.rsi <= 55,
    "②相對強勢未過熱（20日報酬前30%、RSI<65、距MA20<8%）": (r) =>
      top30.has(r) && r.m.rsi != null && r.m.rsi < 65 && r.m.ma20BiasPct != null && r.m.ma20BiasPct < 8,
    "③法人連買3日且5日漲幅<5%": (r) => r.inst3 === true && r.m.ret5 != null && r.m.ret5 < 5,
    "④月營收年增>20%且距MA20<5%": (r) => r.revYoy != null && r.revYoy > 20 && r.m.ma20BiasPct != null && r.m.ma20BiasPct < 5,
  };
  const half1 = new Set(SIGNAL_DATES.slice(0, 8));
  console.log("\n【五、替代選股邏輯（門檻事先定好、不調參）：全期／前半（8/3～8/25）／後半（8/31～9/22）】");
  console.log(`（資料覆蓋：法人連3日 ${rows.filter((r) => r.inst3 != null).length}/${rows.length} 筆、月營收 ${rows.filter((r) => r.revYoy != null).length}/${rows.length} 筆）`);
  for (const [name, f] of Object.entries(ALT)) {
    const sel = rows.filter(f);
    line(`${name}｜全期`, sel);
    line(`　前半`, sel.filter((r) => half1.has(r.date)));
    line(`　後半`, sel.filter((r) => !half1.has(r.date)));
  }

  // ⑤ 現行「先不要買」組為什麼是正超額：拆解
  const cur = Object.keys(VARIANTS).at(-1)!;
  const avoid = rows.filter((r) => r.codes[cur] === "avoid" && r.x5 != null);
  console.log("\n【六、現行「先不要買」組拆解】");
  line("先不要買 全部", avoid);
  line("　技術面支持（被籌碼／破底擋下）", avoid.filter((r) => r.techSupport));
  line("　技術面非支持", avoid.filter((r) => !r.techSupport));
  line("　籌碼面不支持（法人賣超）", avoid.filter((r) => r.chips === "不支持"));
  line("　籌碼面支持", avoid.filter((r) => r.chips === "支持"));
  line("　前半", avoid.filter((r) => half1.has(r.date)));
  line("　後半", avoid.filter((r) => !half1.has(r.date)));
  const bySym = new Map<string, { n: number; sum: number }>();
  for (const r of avoid) {
    const s = bySym.get(r.sym) ?? { n: 0, sum: 0 };
    s.n++;
    s.sum += r.x5!;
    bySym.set(r.sym, s);
  }
  const total = avoid.reduce((a, r) => a + r.x5!, 0);
  const sorted = [...bySym.entries()].sort((a, b) => b[1].sum - a[1].sum);
  const fmt = ([s, v]: [string, { n: number; sum: number }]) => `${s}（${v.n}筆、合計${v.sum >= 0 ? "+" : ""}${v.sum.toFixed(1)}）`;
  console.log(`超額合計 ${total.toFixed(1)}（${avoid.length} 筆）；貢獻最多：${sorted.slice(0, 8).map(fmt).join("、")}`);
  console.log(`拖累最多：${sorted.slice(-5).reverse().map(fmt).join("、")}`);
  const top5 = new Set(sorted.slice(0, 5).map(([s]) => s));
  line("　扣掉貢獻前 5 檔後", avoid.filter((r) => !top5.has(r.sym)));
}

if (process.argv.includes("--wide")) {
  // 擴大樣本回測（200 檔分層、約 2 年；資料用 wideFetch.ts 下載，見 wide.ts）
  import("./wide").then((m) => m.runWide());
} else if (process.argv.includes("--alt")) {
  const rows = buildRows();
  alternatives(rows);
} else {
  main();
}
