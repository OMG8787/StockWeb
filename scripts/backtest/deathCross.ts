/**
 * 死亡交叉後的表現（2026-10-07：使用者看到宏璟「今天出現 KD 死亡交叉」仍建議買進，問「出現死亡交叉真的還可以買嗎」）。
 *   npx tsx scripts/backtest/deathCross.ts
 * 只讀既有快取的 K 線（樣本內 198 檔／樣本外 194 檔，每個交易日）。規則看結果前寫死：
 *  - 事件：KD 死亡交叉日（遞迴版 K 由上往下穿 D）、MACD 死亡交叉日、兩者同日；以及「多頭結構中的死叉」＝事件日同時
 *    均線多頭排列（5>10>20 日均線）且收盤站上 20 日均線（宏璟當天的狀態）。
 *  - 對照組：同樣是多頭結構（均線多頭排列＋站上 20 日線）但當天沒有死叉的股票日。
 *  - 報酬：事件日收盤買進、持有 5／10／20 個交易日；超額＝個股報酬 − 同一天全部樣本股票的平均報酬（扣掉大盤漲跌）。
 *  - t 值：先把同一天的事件超額取平均（避免同一天多檔高度相關），再對「天」做 t 檢定（重疊持有期仍有自相關，t 只當粗略參考）。
 *  - 判讀：多頭結構中的死叉，超額報酬若顯著低於對照組（差距的 t ≤ −2，且樣本內外同向），才有理由提高死叉權重；否則維持現行（只算一個空方訊號，說明要講清楚）。
 */
import { computeKdSeries } from "@/lib/indicators";
import { computeMacdLines, MACD_MIN_BARS } from "@/lib/ema";
import { IS, OOS, type PeriodConfig } from "./regimeConfig";
import { buildUniverseFor, loadCandlesFor } from "./regimeData";

const HORIZONS = [5, 10, 20] as const;
type Group = "all" | "kdDeath" | "macdDeath" | "bothDeath" | "bullKdDeath" | "bullMacdDeath" | "bullNoDeath";
const GROUPS: Group[] = ["all", "kdDeath", "macdDeath", "bothDeath", "bullKdDeath", "bullMacdDeath", "bullNoDeath"];
const LABEL: Record<Group, string> = {
  all: "全部股票日（基準）",
  kdDeath: "KD 死叉日",
  macdDeath: "MACD 死叉日",
  bothDeath: "KD＋MACD 同日死叉",
  bullKdDeath: "多頭結構中的 KD 死叉",
  bullMacdDeath: "多頭結構中的 MACD 死叉",
  bullNoDeath: "多頭結構、無死叉（對照）",
};

interface Obs { date: string; ret: number }
const sma = (v: number[], i: number, n: number) => (i >= n - 1 ? v.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n : null);

function run(p: PeriodConfig) {
  const { universe } = buildUniverseFor(p);
  const cal = new Set(loadCandlesFor(p, "2330")!.map((c) => c.time).filter((d) => d >= p.signalStart && d <= p.signalEnd));
  // obs[group][h] 為 { date, ret }[]
  const obs = Object.fromEntries(GROUPS.map((g) => [g, Object.fromEntries(HORIZONS.map((h) => [h, [] as Obs[]]))])) as Record<Group, Record<number, Obs[]>>;
  for (const u of universe) {
    const cs = loadCandlesFor(p, u.sym);
    if (!cs || cs.length < MACD_MIN_BARS + 30) continue;
    const closes = cs.map((c) => c.close);
    const kd = computeKdSeries(cs);
    const kMap = new Map(kd.k.map((x) => [x.time, x.value]));
    const dMap = new Map(kd.d.map((x) => [x.time, x.value]));
    const { macdLine, signalLine } = computeMacdLines(closes);
    for (let i = 70; i < cs.length - 1; i++) {
      if (!cal.has(cs[i].time)) continue;
      const k0 = kMap.get(cs[i].time), d0 = dMap.get(cs[i].time), k1 = kMap.get(cs[i - 1].time), d1 = dMap.get(cs[i - 1].time);
      const kdDeath = k0 != null && d0 != null && k1 != null && d1 != null && k1 >= d1 && k0 < d0;
      const m0 = macdLine[i], s0 = signalLine[i], m1 = macdLine[i - 1], s1 = signalLine[i - 1];
      const macdDeath = m0 != null && s0 != null && m1 != null && s1 != null && m1 >= s1 && m0 < s0;
      const m5 = sma(closes, i, 5), m10 = sma(closes, i, 10), m20 = sma(closes, i, 20);
      const bull = m5 != null && m10 != null && m20 != null && m5 > m10 && m10 > m20 && closes[i] > m20;
      const groups: Group[] = ["all"];
      if (kdDeath) groups.push("kdDeath");
      if (macdDeath) groups.push("macdDeath");
      if (kdDeath && macdDeath) groups.push("bothDeath");
      if (bull && kdDeath) groups.push("bullKdDeath");
      if (bull && macdDeath) groups.push("bullMacdDeath");
      if (bull && !kdDeath && !macdDeath) groups.push("bullNoDeath");
      for (const h of HORIZONS) {
        if (i + h >= cs.length) continue;
        const ret = (closes[i + h] / closes[i] - 1) * 100;
        for (const g of groups) obs[g][h].push({ date: cs[i].time, ret });
      }
    }
  }
  return obs;
}

function summarize(obs: Record<Group, Record<number, Obs[]>>, g: Group, h: number) {
  // 同一天全部股票的平均報酬
  const dayMean = new Map<string, { s: number; n: number }>();
  for (const o of obs.all[h]) {
    const e = dayMean.get(o.date) ?? { s: 0, n: 0 };
    e.s += o.ret; e.n++; dayMean.set(o.date, e);
  }
  const byDate = new Map<string, number[]>();
  for (const o of obs[g][h]) {
    const dm = dayMean.get(o.date)!;
    const ex = o.ret - dm.s / dm.n;
    (byDate.get(o.date) ?? byDate.set(o.date, []).get(o.date)!).push(ex);
  }
  const perDay = [...byDate.values()].map((a) => a.reduce((x, y) => x + y, 0) / a.length);
  const n = perDay.length;
  const mean = perDay.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const sd = Math.sqrt(perDay.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const all = obs[g][h].map((o) => o.ret - dayMean.get(o.date)!.s / dayMean.get(o.date)!.n);
  const meanAll = all.reduce((a, b) => a + b, 0) / Math.max(1, all.length);
  return { n: all.length, days: n, meanAll, meanDay: mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : NaN, raw: obs[g][h].reduce((a, o) => a + o.ret, 0) / Math.max(1, obs[g][h].length) };
}

const res = { is: run(IS), oos: run(OOS) };
for (const [key, p] of [["is", IS], ["oos", OOS]] as const) {
  console.log(`\n## ${p.label}（超額＝個股報酬−同日全樣本平均；t 對「天」計算）`);
  console.log("| 組別 | 持有 | 事件數（天數） | 平均報酬 | 平均超額 | 超額 t |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const g of GROUPS) {
    for (const h of HORIZONS) {
      const s = summarize(res[key], g, h);
      console.log(`| ${LABEL[g]} | ${h}日 | ${s.n}（${s.days}） | ${s.raw.toFixed(2)}% | ${s.meanAll.toFixed(2)}% | ${s.t.toFixed(2)} |`);
    }
  }
}
// 多頭結構中死叉 vs 對照組的差距（以日平均超額相減，簡單估計）
console.log("\n## 多頭結構中的死叉 − 對照組（平均超額差，負＝死叉較差）");
for (const [key, p] of [["is", IS], ["oos", OOS]] as const) {
  for (const h of HORIZONS) {
    const a = summarize(res[key], "bullKdDeath", h), c = summarize(res[key], "bullNoDeath", h);
    const b = summarize(res[key], "bullMacdDeath", h);
    console.log(`${p.label} ${h}日：KD 死叉 ${(a.meanAll - c.meanAll).toFixed(2)}%、MACD 死叉 ${(b.meanAll - c.meanAll).toFixed(2)}%`);
  }
}
