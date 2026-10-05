import { AI_ADJUST_PROMOTION } from "./aiAdjust";
import { conclusionReward, REWARD_HORIZONS, type HorizonOutcome } from "./reward";
import type { EvalRecord } from "./types";
import type { BasisStat } from "./weights";

/**
 * 冠軍／挑戰者（學習循環第二階段，純邏輯、有測試）：冠軍＝程式評等、挑戰者＝AI 調整後結論。
 * 只拿「有 AI 判斷」的紀錄比（同一批股票、同一個時間點，配對比較才公平）；兩邊的報酬、超額、回撤相同，
 * 差別只在結論不同時的結論獎勵（reward.ts conclusionReward）。
 * 放寬判準見 aiAdjust.ts AI_ADJUST_PROMOTION（常數旁有說明），結果顯示在 /scoreboard。
 */

type H = "1" | "5" | "20";

export interface SideStat {
  /** 結論獎勵 > 0 的比例（%） */
  winRate: number | null;
  avgReward: number | null;
}

export interface ChallengerRow {
  h: H;
  /** 有 AI 判斷且這個期間已滿的筆數 */
  n: number;
  /** 其中 AI 實際調整（delta≠0）的筆數 */
  adjustedN: number;
  program: SideStat;
  ai: SideStat;
}

export interface ChampionChallenger {
  rows: ChallengerRow[];
  /** 5 日配對差（AI 獎勵−程式獎勵）的平均與 t 值（只算 AI 有調整的；樣本 <2 為 null） */
  edge5: { n: number; mean: number | null; t: number | null };
  promotion: { ready: boolean; checks: Array<{ label: string; ok: boolean }> };
  /** 「AI調整」這個判斷依據在依據權重表裡的列 */
  aiBasis: BasisStat[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const avg = (v: number[]) => (v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null);
const win = (v: number[]) => (v.length ? Math.round((v.filter((x) => x > 0).length / v.length) * 100) : null);

/** AI 調整後結論在某期間的結論獎勵（沒有 AI 判斷、或期間未滿／缺大盤資料回 null）。 */
export function aiReward(r: EvalRecord, h: H): number | null {
  const o = r.o[h];
  if (!r.ai || !o || o.ex == null || o.brw == null) return null;
  return r2(conclusionReward(r.ai.code, o.ex, o.brw));
}

/** 依紀錄的已知結果算 AI 調整後結論的各期間結果（存進 EvalRecord.ai.o，看板與日後分析用）。 */
export function aiOutcomes(r: EvalRecord): Partial<Record<H, HorizonOutcome>> {
  const out: Partial<Record<H, HorizonOutcome>> = {};
  for (const hn of REWARD_HORIZONS) {
    const h = String(hn) as H;
    const o = r.o[h];
    const rw = aiReward(r, h);
    if (o) out[h] = { ...o, rw };
  }
  return out;
}

export function summarizeChampionChallenger(records: EvalRecord[], basisStats: BasisStat[] = []): ChampionChallenger {
  const withAi = records.filter((r) => r.ai);
  const rows: ChallengerRow[] = REWARD_HORIZONS.map((hn) => {
    const h = String(hn) as H;
    const pairs = withAi.flatMap((r) => {
      const p = r.o[h]?.rw;
      const a = aiReward(r, h);
      return p != null && a != null ? [{ p, a, adj: (r.ai?.delta ?? 0) !== 0 }] : [];
    });
    return {
      h,
      n: pairs.length,
      adjustedN: pairs.filter((x) => x.adj).length,
      program: { winRate: win(pairs.map((x) => x.p)), avgReward: avg(pairs.map((x) => x.p)) },
      ai: { winRate: win(pairs.map((x) => x.a)), avgReward: avg(pairs.map((x) => x.a)) },
    };
  });
  const diffs = withAi.flatMap((r) => {
    const p = r.o["5"]?.rw;
    const a = aiReward(r, "5");
    return p != null && a != null && (r.ai?.delta ?? 0) !== 0 ? [a - p] : [];
  });
  const mean = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null;
  let t: number | null = null;
  if (diffs.length >= 2 && mean != null) {
    const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (diffs.length - 1));
    t = sd > 0 ? r2(mean / (sd / Math.sqrt(diffs.length))) : null;
  }
  const row5 = rows.find((r) => r.h === "5")!;
  // 全部 5 日配對樣本的平均獎勵差（delta=0 的兩邊相同，差只來自調整過的那些）。
  const edgeAll = row5.ai.avgReward != null && row5.program.avgReward != null ? r2(row5.ai.avgReward - row5.program.avgReward) : null;
  const P = AI_ADJUST_PROMOTION;
  const checks = [
    { label: `有 AI 判斷且滿 5 日 ≥ ${P.minSamples} 筆（目前 ${row5.n}）`, ok: row5.n >= P.minSamples },
    { label: `其中 AI 實際調整 ≥ ${P.minAdjusted} 筆（目前 ${row5.adjustedN}）`, ok: row5.adjustedN >= P.minAdjusted },
    {
      label: `AI 調整後 5 日平均獎勵高於程式評等 ≥ ${P.minEdgePct} 個百分點（目前 ${edgeAll == null ? "—" : `${edgeAll >= 0 ? "+" : ""}${edgeAll}`}）`,
      ok: edgeAll != null && edgeAll >= P.minEdgePct,
    },
    { label: `逐筆配對差 t 值 ≥ ${P.minT}（目前 ${t ?? "—"}）`, ok: t != null && t >= P.minT },
  ];
  return {
    rows,
    edge5: { n: diffs.length, mean: mean == null ? null : r2(mean), t },
    promotion: { ready: checks.every((c) => c.ok), checks },
    aiBasis: basisStats.filter((b) => b.basis.startsWith("ai:")),
  };
}
