/**
 * KD「即將交叉」門檻重新校準（2026-10-07：KD 預設改為券商遞迴版後，nearCross.ts 的 KD 門檻原本是為 SMA 序列
 * 憑經驗訂的，遞迴版線條較平滑、K 與 D 的差距尺度不同，不能直接沿用）。
 *   npx tsx scripts/backtest/kdNearCross.ts
 * 用既有快取的 K 線（樣本內 198 檔／樣本外 194 檔，每個交易日），不打任何上游。
 *
 * 校準規則（看結果前寫死）：
 *  - 「命中」＝訊號日之後 3 個交易日內，K 真的往預測方向穿越 D（黃金：K>D；死亡：K<D）。
 *  - 基準＝同一算法下「所有符合候選方向（黃金候選：K<D；死亡候選：K>D）的股票日」3 日內發生該方向交叉的比例；
 *    提升倍數＝命中率÷基準。
 *  - 現行 SMA 門檻（maxGap 5、連續收斂 2 天、外推 ≤3 天）當作「本站使用者已經接受的品質」，量出它的命中率與訊號頻率。
 *  - 候選網格：maxGap ∈ {1,1.5,2,2.5,3,4,5,6,8}、收斂天數 ∈ {1,2,3}、外推天數上限 ∈ {2,3,4,5}。
 *  - 選法：只用樣本內挑——在「遞迴版命中率 ≥ SMA 現行命中率」的候選中，選訊號頻率最接近 SMA 現行頻率的；
 *    再用樣本外確認（命中率與頻率不能明顯崩壞）。
 */
import { detectNearCross } from "@/lib/nearCross";
import { computeKdSeries } from "@/lib/indicators";
import type { KdMethod } from "@/lib/kdFormula";
import { IS, OOS, type PeriodConfig } from "./regimeConfig";
import { buildUniverseFor, loadCandlesFor } from "./regimeData";

const GAPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
const CONVS = [1, 2, 3];
const ESTS = [2, 3, 4, 5];
const HORIZON = 3;
const CUR = { gap: 5, conv: 2, est: 3 };

interface Cfg { gap: number; conv: number; est: number }
interface Res { n: number; hit: number; stockDays: number; cand: number; candHit: number }

function evalPeriod(p: PeriodConfig, method: KdMethod, cfgs: Cfg[]): Map<string, Res> {
  const { universe } = buildUniverseFor(p);
  const out = new Map<string, Res>(cfgs.map((c) => [key(c), { n: 0, hit: 0, stockDays: 0, cand: 0, candHit: 0 }]));
  const cal = new Set(loadCandlesFor(p, "2330")!.map((c) => c.time).filter((d) => d >= p.signalStart && d <= p.signalEnd));
  for (const u of universe) {
    const cs = loadCandlesFor(p, u.sym);
    if (!cs) continue;
    const kd = computeKdSeries(cs, method);
    const kMap = new Map(kd.k.map((x) => [x.time, x.value]));
    const dMap = new Map(kd.d.map((x) => [x.time, x.value]));
    const kv = cs.map((c) => kMap.get(c.time) ?? null);
    const dv = cs.map((c) => dMap.get(c.time) ?? null);
    for (let i = 70; i < cs.length - HORIZON; i++) {
      if (!cal.has(cs[i].time)) continue;
      const k0 = kv[i], d0 = dv[i];
      if (k0 == null || d0 == null || k0 === d0) continue;
      const dir = k0 < d0 ? "golden" : "death";
      // 未來 3 日內是否往預測方向穿越
      let crossed = false;
      for (let j = i + 1; j <= i + HORIZON; j++) {
        const a = kv[j], b = dv[j];
        if (a == null || b == null) continue;
        if (dir === "golden" ? a > b : a < b) { crossed = true; break; }
      }
      const lo = Math.max(0, i - 6);
      const fastW = kv.slice(lo, i + 1), slowW = dv.slice(lo, i + 1);
      for (const c of cfgs) {
        const r = out.get(key(c))!;
        r.stockDays++;
        r.cand++;
        if (crossed) r.candHit++;
        const nc = detectNearCross(fastW, slowW, { convergingDays: c.conv, maxEstDays: c.est, maxGap: c.gap });
        if (nc) {
          r.n++;
          if (crossed) r.hit++;
        }
      }
    }
  }
  return out;
}
const key = (c: Cfg) => `${c.gap}|${c.conv}|${c.est}`;

const cfgs: Cfg[] = [];
for (const gap of GAPS) for (const conv of CONVS) for (const est of ESTS) cfgs.push({ gap, conv, est });
if (!cfgs.some((c) => key(c) === key(CUR))) cfgs.push(CUR);

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const res: Record<string, Record<KdMethod, Map<string, Res>>> = {};
for (const p of [IS, OOS]) {
  res[p.key] = { sma: evalPeriod(p, "sma", cfgs), recursive: evalPeriod(p, "recursive", cfgs) };
}
const rate = (r: Res) => (r.n ? r.hit / r.n : NaN);
const base = (r: Res) => r.candHit / r.cand;
const freq = (r: Res) => (r.n / r.stockDays) * 21; // 每檔每月

console.log("\n## 現行 SMA 門檻（gap 5／收斂 2／外推 3）在 SMA 序列上的品質（基準）");
for (const p of [IS, OOS]) {
  const r = res[p.key].sma.get(key(CUR))!;
  console.log(`${p.label}：訊號 ${r.n} 次（每檔每月 ${freq(r).toFixed(3)}），3日內真的交叉 ${pct(rate(r))}，同候選基準 ${pct(base(r))}，提升 ${(rate(r) / base(r)).toFixed(2)} 倍`);
}
const smaIs = res.is.sma.get(key(CUR))!;
const targetRate = rate(smaIs), targetFreq = freq(smaIs);
console.log("\n## 現行 SMA 門檻直接套在遞迴序列上（不校準的後果）");
for (const p of [IS, OOS]) {
  const r = res[p.key].recursive.get(key(CUR))!;
  console.log(`${p.label}：訊號 ${r.n} 次（每檔每月 ${freq(r).toFixed(3)}），命中 ${pct(rate(r))}，基準 ${pct(base(r))}，提升 ${(rate(r) / base(r)).toFixed(2)} 倍`);
}
console.log(`\n## 遞迴版候選（樣本內：命中率 ≥ ${pct(targetRate)} 的前 12 名，依與 SMA 現行頻率 ${targetFreq.toFixed(3)} 的接近程度排序）`);
const ranked = cfgs
  .map((c) => ({ c, r: res.is.recursive.get(key(c))! }))
  .filter(({ r }) => r.n >= 200 && rate(r) >= targetRate)
  .sort((a, b) => Math.abs(freq(a.r) - targetFreq) - Math.abs(freq(b.r) - targetFreq));
console.log("| maxGap | 收斂天數 | 外推上限 | 樣本內 次數／每檔每月／命中 | 樣本外 次數／每檔每月／命中（提升倍數） |");
console.log("|---:|---:|---:|---|---|");
for (const { c, r } of ranked.slice(0, 12)) {
  const o = res.oos.recursive.get(key(c))!;
  console.log(`| ${c.gap} | ${c.conv} | ${c.est} | ${r.n}／${freq(r).toFixed(3)}／${pct(rate(r))} | ${o.n}／${freq(o).toFixed(3)}／${pct(rate(o))}（${(rate(o) / base(o)).toFixed(2)}×） |`);
}
const o = res.oos.sma.get(key(CUR))!;
console.log(`\n參考：SMA 現行 樣本外 ${o.n}／${freq(o).toFixed(3)}／${pct(rate(o))}（${(rate(o) / base(o)).toFixed(2)}×）`);
