import type { RatingCode } from "../siteRating";
import { LESSONS, type Lesson, type LessonCondition } from "../lessons";
import type { RatingFeatures } from "./features";
import type { EvalRecord } from "./types";

/** 教訓比對與驗證（純邏輯、有測試；資料在 ../lessons.ts）。 */

export const LESSONS_TITLE = "【相關教訓（本站歷史檢討）】";
/** 一檔最多附幾條。 */
export const LESSONS_MAX_PER_STOCK = 3;
/** 驗證時至少幾筆符合條件的紀錄才下「成立／不成立」結論。 */
export const LESSON_VALIDATE_MIN_SAMPLES = 20;

function condOk(f: RatingFeatures, c: LessonCondition): boolean {
  const v = f[c.field];
  if (v == null) return false;
  switch (c.op) {
    case ">=":
      return v >= c.value;
    case ">":
      return v > c.value;
    case "<=":
      return v <= c.value;
    case "<":
      return v < c.value;
  }
}

export function lessonApplies(l: Lesson, f: RatingFeatures | undefined, code: RatingCode): boolean {
  if (l.status === "已失效") return false;
  if (l.codes && !l.codes.includes(code)) return false;
  const groups = l.anyOf ?? (l.when.length > 0 ? [l.when] : []);
  if (groups.length === 0) return true;
  if (!f) return false;
  return groups.some((g) => g.every((c) => condOk(f, c)));
}

/** 跟這檔相關的教訓（有效優先，再依證據超額絕對值），最多 LESSONS_MAX_PER_STOCK 條。 */
export function matchLessons(f: RatingFeatures | undefined, code: RatingCode, lessons: Lesson[] = LESSONS): Lesson[] {
  return lessons
    .filter((l) => lessonApplies(l, f, code))
    .sort(
      (a, b) =>
        (a.status === "有效" ? 0 : 1) - (b.status === "有效" ? 0 : 1) ||
        Math.abs(b.evidence.excessPct ?? 0) - Math.abs(a.evidence.excessPct ?? 0)
    )
    .slice(0, LESSONS_MAX_PER_STOCK);
}

function evidenceText(l: Lesson): string {
  const e = l.evidence;
  const nums = [
    e.n != null ? `樣本 ${e.n} 筆` : "",
    e.excessPct != null ? `5日超額 ${e.excessPct >= 0 ? "+" : ""}${e.excessPct}%` : "",
    e.winRatePct != null ? `跑贏 ${e.winRatePct}%` : "",
  ].filter(Boolean);
  return `${nums.length ? nums.join("、") + "；" : ""}來源：${e.source}`;
}

export function describeLessons(lessons: Lesson[]): string | undefined {
  if (lessons.length === 0) return undefined;
  return `${LESSONS_TITLE}${lessons
    .map((l, i) => `${i + 1}. [${l.status}] ${l.condition}：${l.advice}（${evidenceText(l)}）`)
    .join("；")}`;
}

export interface LessonValidation {
  id: string;
  condition: string;
  status: Lesson["status"];
  /** 符合條件、已滿 5 日的紀錄筆數 */
  n: number;
  avgExcess: number | null;
  /** 符合條件時買進 5 日超額 > 0 的比例 */
  winRate: number | null;
  verdict: "樣本不足" | "證據仍成立" | "證據已不成立";
}

/** 用評等紀錄的實際結果重新驗證每條教訓（只列結論，不改資料）。 */
export function validateLessons(records: EvalRecord[], lessons: Lesson[] = LESSONS): LessonValidation[] {
  return lessons.map((l) => {
    const xs = records.flatMap((r) => {
      const ex = r.o["5"]?.ex;
      return ex != null && lessonApplies({ ...l, status: "有效" }, r.f, r.code) ? [ex] : [];
    });
    const n = xs.length;
    const avgExcess = n ? Math.round((xs.reduce((a, b) => a + b, 0) / n) * 100) / 100 : null;
    const winRate = n ? Math.round((xs.filter((x) => x > 0).length / n) * 100) : null;
    const verdict: LessonValidation["verdict"] =
      n < LESSON_VALIDATE_MIN_SAMPLES || avgExcess == null
        ? "樣本不足"
        : Math.sign(avgExcess) === l.expectedExcessSign
          ? "證據仍成立"
          : "證據已不成立";
    return { id: l.id, condition: l.condition, status: l.status, n, avgExcess, winRate, verdict };
  });
}
