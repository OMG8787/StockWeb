/**
 * 依據權重上線前檢查（AI 學習循環第一階段，2026-10-05）：
 *   npx tsx scripts/backtest/weights.ts            # 用擴大回測的本機資料（先跑 wideFetch.ts），等同「--weights 模式」
 *   npx tsx scripts/backtest/weights.ts --from-site # 改用正式站評等紀錄（/api/learning?records=1；累積夠多後用這個）
 *
 * 做法（跟正式站同一套程式：features.ts／reward.ts／weights.ts）：
 * 1. 每筆樣本算「判斷依據鍵＋市況＋5 日若買進獎勵」（擴大回測資料：200 檔×每週最後一個交易日，收盤價進場、對加權指數）。
 * 2. 依日期切成前段（學權重）／後段（驗證，前段沒用過），中間空 WEIGHTS_EMBARGO_DAYS 天避免 5 日報酬重疊。
 * 3. 用前段學到的權重（只取達樣本門檻的）算後段每筆的 learnedScoreAdjustment，看：
 *    - 調整 > 0 與 < 0 兩組的後段平均獎勵差（要 > 0 才代表權重有預測力）；
 *    - 「建議買進」組若剔除調整 < 0 的，平均獎勵有沒有變好。
 * 4. 兩項都通過（且後段樣本夠）才印「通過」；LEARNED_WEIGHTS_ENABLED 只有在通過後才可考慮打開。
 *
 * 限制：擴大回測資料沒有歷史的基本面／財報／持股結構／融資，那幾個依據在這裡不會出現；正式站紀錄才有完整依據。
 * 只新增這個檔案，不改 run.ts／wide*.ts 既有行為（只 import wideData.ts 的唯讀載入函式）。
 */
import type { Candle } from "@/lib/data/types";
import { siteAuthHeaders } from "../siteAuth";
import { computeRatingCore } from "@/lib/ai/ratingCore";
import { ACTIVE_CHASE_GUARDS } from "@/lib/ai/chaseGuards";
import { computeRatingFeatures, featureBases, similarKey } from "@/lib/ai/learning/features";
import { classifyRegime, REGIME_LABEL, type MarketRegime } from "@/lib/ai/learning/regime";
import { computeOutcome } from "@/lib/ai/learning/reward";
import { computeBasisStats, learnedScoreAdjustment, toWeightTable } from "@/lib/ai/learning/weights";
import type { EvalRecord } from "@/lib/ai/learning/types";
import { buildUniverse, loadCandles, loadChips, revenueYoyAsOf, weeklySignalDates } from "./wideData";
import { SIGNAL_END, SIGNAL_START } from "./wideConfig";

/** 前段（學權重）占日期的比例。 */
export const WEIGHTS_TRAIN_FRACTION = 0.6;
/** 前後段之間空幾個日曆天（5 日報酬不重疊）。 */
export const WEIGHTS_EMBARGO_DAYS = 10;
/** 後段至少幾筆才下結論。 */
export const WEIGHTS_MIN_TEST_SAMPLES = 300;

const SITE = process.env.BACKTEST_SITE ?? "https://stock-web-blond.vercel.app";

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const f2 = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "—");

function buildFromWide(): EvalRecord[] {
  const twii = loadCandles("_TWII");
  const cal = loadCandles("2330");
  if (!twii || !cal) throw new Error("找不到擴大回測日K快取，請先跑 npx tsx scripts/backtest/wideFetch.ts");
  const dates = weeklySignalDates(cal.map((c) => c.time), SIGNAL_START, SIGNAL_END);
  const regimeOf = new Map<string, MarketRegime | null>();
  for (const d of dates) regimeOf.set(d, classifyRegime(twii.filter((c) => c.time <= d).map((c) => c.close)));
  const out: EvalRecord[] = [];
  for (const u of buildUniverse()) {
    const cs = loadCandles(u.sym);
    if (!cs) continue;
    const idx = new Map(cs.map((c, i) => [c.time, i]));
    for (const date of dates) {
      const i = idx.get(date);
      if (i == null || i < 63 || cs[i].volume === 0) continue;
      const price = cs[i].close;
      const hist: Candle[] = cs.slice(0, i + 1);
      const win = hist.slice(-63);
      const chips = loadChipsCached(date).get(u.sym) ?? null;
      // 正式評等核心（src/lib/ai/ratingCore.ts，跟 stockRating.ts 同一個函式）。
      const { scored, framework, chase, rating } = computeRatingCore({
        symbol: u.sym, name: u.name, price, market: "TW", candles: win, chaseCandles: hist, asOfDay: date, chips,
        guards: ACTIVE_CHASE_GUARDS,
      });
      const ry = revenueYoyAsOf(date, u.sym);
      const f = computeRatingFeatures({
        candles: win, price, chase, chips, chipsRatios: null,
        earnings: ry == null ? null : { monthlyRevenueYoyPercent: ry }, framework, sectorDirection: null,
      });
      const o5 = computeOutcome({ code: rating.code, price, day: date, preOpen: false }, cs.slice(i + 1, i + 25), twii, 5);
      if (!o5 || o5.brw == null) continue;
      const rg = regimeOf.get(date) ?? null;
      out.push({
        at: `${date}T05:30:00Z`, day: date, sym: u.sym, name: u.name, code: rating.code, price, rg,
        bases: featureBases(f, Object.fromEntries(scored.facets.map((x) => [x.name.replace(/（.*$/, ""), x.verdict])), rating.chaseHits.map((h) => h.id)),
        f, sk: similarKey(f, rg), o: { "5": o5 },
      });
    }
  }
  return out;
}

const chipsCache = new Map<string, ReturnType<typeof loadChips>>();
function loadChipsCached(d: string) {
  if (!chipsCache.has(d)) chipsCache.set(d, loadChips(d));
  return chipsCache.get(d)!;
}

async function buildFromSite(): Promise<EvalRecord[]> {
  const res = await fetch(`${SITE}/api/learning?records=1`, { headers: siteAuthHeaders() });
  const j = (await res.json()) as { items?: EvalRecord[] };
  return (j.items ?? []).filter((r) => r.o["5"]?.brw != null);
}

async function main() {
  const fromSite = process.argv.includes("--from-site");
  const recs = (fromSite ? await buildFromSite() : buildFromWide()).sort((a, b) => a.day.localeCompare(b.day));
  const days = [...new Set(recs.map((r) => r.day))];
  if (days.length < 4) {
    console.log(`樣本日期只有 ${days.length} 天（${recs.length} 筆），無法切前後段——評等紀錄累積不夠，權重不可上線。`);
    return;
  }
  const cut = days[Math.floor(days.length * WEIGHTS_TRAIN_FRACTION)];
  const testStart = new Date(Date.parse(`${cut}T00:00:00Z`) + WEIGHTS_EMBARGO_DAYS * 86_400_000).toISOString().slice(0, 10);
  const train = recs.filter((r) => r.day < cut);
  const test = recs.filter((r) => r.day >= testStart);
  const stats = computeBasisStats(train, train.at(-1)!.day);
  const table = toWeightTable(stats);
  console.log(`資料：${fromSite ? "正式站評等紀錄" : "擴大回測本機資料"}，${recs.length} 筆`);
  console.log(`前段（學權重）：${train[0]?.day}～${train.at(-1)?.day}，${train.length} 筆；後段（驗證）：${test[0]?.day ?? "—"}～${test.at(-1)?.day ?? "—"}，${test.length} 筆`);
  console.log(`前段達樣本門檻的依據×市況：${Object.keys(table).length} 組（共 ${stats.length} 組）`);
  const top = stats.filter((s) => s.active).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 12);
  for (const s of top) console.log(`  ${s.basis}｜${REGIME_LABEL[s.regime]}：${s.n} 筆、權重 ${f2(s.weight)}、若買進勝率 ${s.winRate}%`);

  const adj = test.map((r) => ({ r, a: learnedScoreAdjustment(r.bases, r.rg, table, true), brw: r.o["5"]!.brw! }));
  const pos = adj.filter((x) => x.a > 0).map((x) => x.brw);
  const neg = adj.filter((x) => x.a < 0).map((x) => x.brw);
  const zero = adj.filter((x) => x.a === 0).map((x) => x.brw);
  const spread = mean(pos) - mean(neg);
  console.log(`\n後段：調整>0 ${pos.length} 筆平均獎勵 ${f2(mean(pos))}；調整<0 ${neg.length} 筆 ${f2(mean(neg))}；調整=0 ${zero.length} 筆 ${f2(mean(zero))}；差距 ${f2(spread)}`);
  for (const rg of ["bull", "bear", "range"] as const) {
    const p = adj.filter((x) => x.r.rg === rg && x.a > 0).map((x) => x.brw);
    const n = adj.filter((x) => x.r.rg === rg && x.a < 0).map((x) => x.brw);
    if (p.length + n.length > 0) console.log(`  ${REGIME_LABEL[rg]}：>0 ${p.length} 筆 ${f2(mean(p))}、<0 ${n.length} 筆 ${f2(mean(n))}`);
  }
  const buy = adj.filter((x) => x.r.code === "buy");
  const buyKept = buy.filter((x) => x.a >= 0);
  const improve = mean(buyKept.map((x) => x.brw)) - mean(buy.map((x) => x.brw));
  console.log(`後段「建議買進」${buy.length} 筆平均獎勵 ${f2(mean(buy.map((x) => x.brw)))}；剔除調整<0 後 ${buyKept.length} 筆 ${f2(mean(buyKept.map((x) => x.brw)))}（改善 ${f2(improve)}）`);

  const enough = test.length >= WEIGHTS_MIN_TEST_SAMPLES && pos.length > 0 && neg.length > 0;
  const pass = enough && spread > 0 && (buy.length === 0 || improve >= 0);
  console.log(
    `\n結論：${!enough ? "後段樣本不足，不下結論（不可打開 LEARNED_WEIGHTS_ENABLED）" : pass ? "通過（權重在未用過的資料上有預測力；仍需人工審查後才打開 LEARNED_WEIGHTS_ENABLED）" : "未通過（不可打開 LEARNED_WEIGHTS_ENABLED）"}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
