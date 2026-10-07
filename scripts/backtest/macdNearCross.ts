/**
 * MACD「即將交叉」門檻校準（2026-10-07：使用者問「有兩種線快線都快超過慢線的嗎」→ 要新增「MACD 與 KD 同時即將黃金交叉」篩選，
 * KD 門檻已在 kdNearCross.ts 用券商遞迴版重校，MACD 門檻同方法驗證）。
 *   npx tsx scripts/backtest/macdNearCross.ts
 * 用既有快取的 K 線（樣本內 198 檔／樣本外 194 檔，每個交易日），不打任何上游。
 *
 * 規則（看結果前寫死，與 KD 相同方法）：
 *  - 「命中」＝訊號日之後 3 個交易日內，DIF 真的往預測方向穿越訊號線（黃金：DIF>訊號線；死亡：DIF<訊號線）。
 *  - 基準＝所有「符合候選方向」股票日的 3 日內交叉比例；提升倍數＝命中率÷基準。
 *  - 現行門檻（收斂 3 天、外推 ≤2 天）量出樣本內命中率與頻率當「已被接受的品質」。
 *  - 候選網格：收斂天數 ∈ {1,2,3,4}、外推天數上限 ∈ {1,1.5,2,3,4,5}（MACD 刻度隨股價，不用固定 maxGap）。
 *  - 選法：只用樣本內挑——命中率 ≥ 現行命中率、且訊號頻率最高（涵蓋最多）的組合；再用樣本外確認不崩壞。
 *  - 另量「KD 與 MACD 同時即將黃金交叉」（用 nearCross.ts 現行常數）的頻率與命中：兩者都在 3 日內交叉的比例、至少一個交叉的比例。
 */
import {
  KD_NEAR_CROSS_CONVERGING_DAYS,
  KD_NEAR_CROSS_MAX_EST_DAYS,
  KD_NEAR_CROSS_MAX_GAP,
  MACD_NEAR_CROSS_CONVERGING_DAYS,
  MACD_NEAR_CROSS_MAX_EST_DAYS,
  detectNearCross,
} from "@/lib/nearCross";
import { computeKdSeries } from "@/lib/indicators";
import { computeMacdLines, MACD_MIN_BARS } from "@/lib/ema";
import { IS, OOS, type PeriodConfig } from "./regimeConfig";
import { buildUniverseFor, loadCandlesFor } from "./regimeData";

const CONVS = [1, 2, 3, 4];
const ESTS = [1, 1.5, 2, 3, 4, 5];
const HORIZON = 3;
const CUR = { conv: MACD_NEAR_CROSS_CONVERGING_DAYS, est: MACD_NEAR_CROSS_MAX_EST_DAYS };

interface Cfg { conv: number; est: number }
interface Res { n: number; hit: number; cand: number; candHit: number }
interface Both { n: number; both: number; any: number; kdOnly: number }

const key = (c: Cfg) => `${c.conv}|${c.est}`;

function evalPeriod(p: PeriodConfig, cfgs: Cfg[]) {
  const { universe } = buildUniverseFor(p);
  const out = new Map<string, Res>(cfgs.map((c) => [key(c), { n: 0, hit: 0, cand: 0, candHit: 0 }]));
  const both: Both = { n: 0, both: 0, any: 0, kdOnly: 0 };
  let stockDays = 0;
  const cal = new Set(loadCandlesFor(p, "2330")!.map((c) => c.time).filter((d) => d >= p.signalStart && d <= p.signalEnd));
  for (const u of universe) {
    const cs = loadCandlesFor(p, u.sym);
    if (!cs || cs.length < MACD_MIN_BARS + 10) continue;
    const { macdLine, signalLine } = computeMacdLines(cs.map((c) => c.close));
    const kd = computeKdSeries(cs);
    const kMap = new Map(kd.k.map((x) => [x.time, x.value]));
    const dMap = new Map(kd.d.map((x) => [x.time, x.value]));
    const kv = cs.map((c) => kMap.get(c.time) ?? null);
    const dv = cs.map((c) => dMap.get(c.time) ?? null);
    for (let i = 70; i < cs.length - HORIZON; i++) {
      if (!cal.has(cs[i].time)) continue;
      const m0 = macdLine[i], s0 = signalLine[i];
      if (m0 == null || s0 == null || m0 === s0) continue;
      stockDays++;
      const dir = m0 < s0 ? "golden" : "death";
      let crossed = false;
      for (let j = i + 1; j <= i + HORIZON; j++) {
        const a = macdLine[j], b = signalLine[j];
        if (a == null || b == null) continue;
        if (dir === "golden" ? a > b : a < b) { crossed = true; break; }
      }
      const lo = Math.max(0, i - 6);
      for (const c of cfgs) {
        const r = out.get(key(c))!;
        r.cand++;
        if (crossed) r.candHit++;
        const nc = detectNearCross(macdLine.slice(lo, i + 1), signalLine.slice(lo, i + 1), { convergingDays: c.conv, maxEstDays: c.est });
        if (nc) {
          r.n++;
          if (crossed) r.hit++;
        }
      }
      // KD 與 MACD 同時即將黃金交叉（現行常數）
      if (dir === "golden") {
        const kn = detectNearCross(kv.slice(lo, i + 1), dv.slice(lo, i + 1), {
          convergingDays: KD_NEAR_CROSS_CONVERGING_DAYS,
          maxEstDays: KD_NEAR_CROSS_MAX_EST_DAYS,
          maxGap: KD_NEAR_CROSS_MAX_GAP,
          requireFastMoving: true,
        });
        const mn = detectNearCross(macdLine.slice(lo, i + 1), signalLine.slice(lo, i + 1), { convergingDays: CUR.conv, maxEstDays: CUR.est });
        if (kn && mn && kn.direction === "golden" && mn.direction === "golden") {
          let kCross = false;
          for (let j = i + 1; j <= i + HORIZON; j++) if (kv[j] != null && dv[j] != null && (kv[j] as number) > (dv[j] as number)) { kCross = true; break; }
          both.n++;
          if (kCross && crossed) both.both++;
          if (kCross || crossed) both.any++;
          if (kCross) both.kdOnly++;
        }
      }
    }
  }
  return { out, both, stockDays };
}

const cfgs: Cfg[] = [];
for (const conv of CONVS) for (const est of ESTS) cfgs.push({ conv, est });
if (!cfgs.some((c) => key(c) === key(CUR))) cfgs.push(CUR);

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const res = { is: evalPeriod(IS, cfgs), oos: evalPeriod(OOS, cfgs) };
const rate = (r: Res) => (r.n ? r.hit / r.n : NaN);
const base = (r: Res) => r.candHit / r.cand;
const freq = (r: Res, sd: number) => (r.n / sd) * 21;

console.log("\n## 現行門檻（收斂", CUR.conv, "天、外推 ≤", CUR.est, "天）");
for (const [name, p] of [["樣本內", res.is], ["樣本外", res.oos]] as const) {
  const r = p.out.get(key(CUR))!;
  console.log(`${name}：訊號 ${r.n} 次（每檔每月 ${freq(r, p.stockDays).toFixed(3)}），3日內真的交叉 ${pct(rate(r))}，同候選基準 ${pct(base(r))}，提升 ${(rate(r) / base(r)).toFixed(2)} 倍`);
}
const curIs = res.is.out.get(key(CUR))!;
const targetRate = rate(curIs);
console.log(`\n## 樣本內命中率 ≥ ${pct(targetRate)} 的候選，依訊號頻率由高到低`);
console.log("| 收斂天數 | 外推上限 | 樣本內 次數／每檔每月／命中（提升） | 樣本外 次數／每檔每月／命中（提升） |");
console.log("|---:|---:|---|---|");
const ranked = cfgs
  .map((c) => ({ c, r: res.is.out.get(key(c))! }))
  .filter(({ r }) => r.n >= 200 && rate(r) >= targetRate)
  .sort((a, b) => b.r.n - a.r.n);
for (const { c, r } of ranked.slice(0, 12)) {
  const o = res.oos.out.get(key(c))!;
  console.log(`| ${c.conv} | ${c.est} | ${r.n}／${freq(r, res.is.stockDays).toFixed(3)}／${pct(rate(r))}（${(rate(r) / base(r)).toFixed(2)}×） | ${o.n}／${freq(o, res.oos.stockDays).toFixed(3)}／${pct(rate(o))}（${(rate(o) / base(o)).toFixed(2)}×） |`);
}
console.log("\n## 全網格（樣本內）");
for (const c of cfgs) {
  const r = res.is.out.get(key(c))!;
  const o = res.oos.out.get(key(c))!;
  console.log(`conv ${c.conv} est ${c.est}：IS ${r.n}／${pct(rate(r))}（${(rate(r) / base(r)).toFixed(2)}×）；OOS ${o.n}／${pct(rate(o))}（${(rate(o) / base(o)).toFixed(2)}×）`);
}
console.log("\n## KD 與 MACD 同時即將黃金交叉（現行常數）");
for (const [name, p] of [["樣本內", res.is], ["樣本外", res.oos]] as const) {
  const b = p.both;
  console.log(`${name}：訊號 ${b.n} 次（每檔每月 ${((b.n / p.stockDays) * 21).toFixed(3)}），3日內兩者都交叉 ${pct(b.both / b.n)}、至少一個交叉 ${pct(b.any / b.n)}、KD 交叉 ${pct(b.kdOnly / b.n)}`);
}
