import type { RatingCode } from "../siteRating";
import { REWARD_HORIZONS } from "./reward";
import type { EvalRecord } from "./types";

/** 成績看板的結論統計與待檢討案例（純邏輯、有測試）。 */

/** 樣本數低於這個值，看板標「樣本不足」。 */
export const SCOREBOARD_MIN_SAMPLES = 10;
/** 「建議買進後大跌」：5 日報酬低於這個 %。 */
export const REVIEW_BUY_DROP_PCT = -5;
/** 「不買卻大漲」：5 日超額高於這個 %。 */
export const REVIEW_MISS_RISE_PCT = 8;
export const REVIEW_MAX_CASES = 12;

export interface CodeHorizonStat {
  code: RatingCode;
  h: string;
  n: number;
  /** 結論獎勵 > 0 的比例（%） */
  winRate: number | null;
  /** 報酬 > 0 的比例（%） */
  upRate: number | null;
  avgExcess: number | null;
  avgReward: number | null;
  insufficient: boolean;
}

export interface ReviewCase {
  day: string;
  sym: string;
  name: string;
  code: RatingCode;
  ret: number;
  ex: number | null;
  kind: "buy-drop" | "miss-rise";
}

const CODES: RatingCode[] = ["buy", "buy-on-pullback", "avoid"];
const avg = (v: number[]) => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null);

export function summarizeByCode(records: EvalRecord[]): CodeHorizonStat[] {
  const out: CodeHorizonStat[] = [];
  for (const code of CODES) {
    for (const hn of REWARD_HORIZONS) {
      const h = String(hn) as "1" | "5" | "20";
      const os = records.filter((r) => r.code === code).flatMap((r) => (r.o[h] && r.o[h]!.rw != null ? [r.o[h]!] : []));
      const n = os.length;
      out.push({
        code,
        h,
        n,
        winRate: n ? Math.round((os.filter((o) => (o.rw ?? 0) > 0).length / n) * 100) : null,
        upRate: n ? Math.round((os.filter((o) => o.ret > 0).length / n) * 100) : null,
        avgExcess: avg(os.flatMap((o) => (o.ex == null ? [] : [o.ex]))),
        avgReward: avg(os.flatMap((o) => (o.rw == null ? [] : [o.rw]))),
        insufficient: n < SCOREBOARD_MIN_SAMPLES,
      });
    }
  }
  return out;
}

export function reviewCases(records: EvalRecord[]): ReviewCase[] {
  const out: ReviewCase[] = [];
  for (const r of records) {
    const o = r.o["5"];
    if (!o) continue;
    if (r.code === "buy" && o.ret <= REVIEW_BUY_DROP_PCT) out.push({ day: r.day, sym: r.sym, name: r.name, code: r.code, ret: o.ret, ex: o.ex, kind: "buy-drop" });
    else if (r.code !== "buy" && o.ex != null && o.ex >= REVIEW_MISS_RISE_PCT)
      out.push({ day: r.day, sym: r.sym, name: r.name, code: r.code, ret: o.ret, ex: o.ex, kind: "miss-rise" });
  }
  return out.sort((a, b) => b.day.localeCompare(a.day)).slice(0, REVIEW_MAX_CASES);
}
