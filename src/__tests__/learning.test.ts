import { describe, expect, it } from "vitest";
import { bucketOf, featureBases, similarKey, type RatingFeatures } from "@/lib/ai/learning/features";
import { classifyRegime } from "@/lib/ai/learning/regime";
import { computeOutcome, conclusionReward, MISS_EXCESS_THRESHOLD_PCT, REWARD_MDD_PENALTY, TRADE_COST_PCT } from "@/lib/ai/learning/reward";
import {
  computeBasisStats,
  decayFactor,
  learnedScoreAdjustment,
  toWeightTable,
  WEIGHT_HALF_LIFE_TRADING_DAYS,
  WEIGHT_MIN_SAMPLES,
  WEIGHT_PRIOR_STRENGTH,
} from "@/lib/ai/learning/weights";
import { buildSimilarTable, describeSimilarCases, lookupSimilar, SIMILAR_CASES_TITLE } from "@/lib/ai/learning/similar";
import { describeLessons, LESSONS_MAX_PER_STOCK, matchLessons, validateLessons, LESSON_VALIDATE_MIN_SAMPLES } from "@/lib/ai/learning/lessonMatch";
import { summarizeByCode, reviewCases } from "@/lib/ai/learning/summary";
import type { EvalRecord } from "@/lib/ai/learning/types";
import type { HorizonOutcome } from "@/lib/ai/learning/reward";

const feat = (over: Partial<RatingFeatures> = {}): RatingFeatures => ({
  v: 1, rsi: 55, r5: 2, r10: 3, r20: 5, b20: 1, b60: 4, vr: 1, k: 50, kx: null, mx: null, m0: 1,
  ii: 1, fi: 1, ti: 0, ist: null, mu: 20, mud: 0.1, ry: 10, sf: null, lu: 0, pos: "in", ...over,
});

const out = (over: Partial<HorizonOutcome>): HorizonOutcome => ({ end: "2026-10-12", ret: 0, idx: 0, ex: 0, mdd: 0, brw: 0, rw: 0, ...over });

function rec(over: Partial<EvalRecord> & { o5?: Partial<HorizonOutcome> }): EvalRecord {
  const { o5, ...rest } = over;
  return {
    at: "2026-10-05T02:00:00Z", day: "2026-10-05", sym: "2330", name: "台積電", code: "buy", price: 100,
    rg: "bull", bases: ["rsi:50~70"], f: feat(), sk: "bull|50~70|0~5", o: { "5": out(o5 ?? {}) }, ...rest,
  };
}

describe("features 分桶與依據鍵", () => {
  it("bucketOf 含左不含右、兩端開放", () => {
    expect(bucketOf("rsi", 29.9)).toBe("<30");
    expect(bucketOf("rsi", 70)).toBe("70~75");
    expect(bucketOf("rsi", 75)).toBe("≥75");
    expect(bucketOf("r5", null)).toBeNull();
  });
  it("featureBases 列出特徵、面向、追高防護", () => {
    const b = featureBases(feat({ rsi: 80, mud: 1, lu: 1 }), { 技術面: "支持", 財報面: "無資料" }, ["surge"]);
    expect(b).toContain("rsi:≥75");
    expect(b).toContain("margin:升");
    expect(b).toContain("lu:有");
    expect(b).toContain("facet:技術面:支持");
    expect(b).not.toContain("facet:財報面:無資料");
    expect(b).toContain("chase:surge");
    expect(featureBases(undefined)).toEqual([]);
  });
  it("similarKey 缺市況或 RSI 回 null", () => {
    expect(similarKey(feat(), "bull")).toBe("bull|50~70|0~5");
    expect(similarKey(feat(), null)).toBeNull();
    expect(similarKey(feat({ rsi: null }), "bull")).toBeNull();
  });
});

describe("市況判斷", () => {
  const ramp = (n: number, step: number) => Array.from({ length: n }, (_, i) => 100 + i * step);
  it("資料不足回 null", () => expect(classifyRegime(ramp(50, 1))).toBeNull());
  it("持續上漲＝多頭、持續下跌＝空頭", () => {
    expect(classifyRegime(ramp(100, 1))).toBe("bull");
    expect(classifyRegime(ramp(100, -0.5))).toBe("bear");
  });
  it("平盤＝盤整", () => expect(classifyRegime(Array(100).fill(100))).toBe("range"));
});

describe("獎勵計算", () => {
  const bars = (closes: number[], start = 6) =>
    closes.map((c, i) => ({ time: `2026-10-${String(start + i).padStart(2, "0")}`, low: c - 1, close: c }));
  const idx = [{ time: "2026-10-05", low: 0, close: 1000 }, ...bars([1000, 1010, 1020, 1030, 1040].map((x) => x), 6)];

  it("建議買進：超額−成本−回撤懲罰", () => {
    const o = computeOutcome({ code: "buy", price: 100, day: "2026-10-05", preOpen: false }, bars([101, 99, 103, 104, 110]), idx, 5)!;
    expect(o.ret).toBe(10);
    expect(o.idx).toBe(4);
    expect(o.ex).toBe(6);
    expect(o.mdd).toBe(2); // 最低 low＝98
    expect(o.brw).toBeCloseTo(6 - TRADE_COST_PCT - REWARD_MDD_PENALTY * 2, 2);
    expect(o.rw).toBe(o.brw);
  });
  it("還沒滿期回 null", () => {
    expect(computeOutcome({ code: "buy", price: 100, day: "2026-10-05", preOpen: false }, bars([101, 102]), idx, 5)).toBeNull();
  });
  it("開盤前評等：當天算第 1 個交易日", () => {
    const o = computeOutcome({ code: "buy", price: 100, day: "2026-10-06", preOpen: true }, bars([105]), idx, 1)!;
    expect(o.end).toBe("2026-10-06");
    expect(o.idx).toBe(0); // 基準＝10/05 收盤 1000、10/06 收盤 1000
  });
  it("不買卻大漲給負獎勵、不買後下跌給正獎勵、小漲為 0", () => {
    expect(conclusionReward("avoid", MISS_EXCESS_THRESHOLD_PCT + 2, 0)).toBe(-(MISS_EXCESS_THRESHOLD_PCT + 2));
    expect(conclusionReward("buy-on-pullback", -4, 0)).toBe(4);
    expect(conclusionReward("avoid", 1, 0)).toBe(0);
  });
  it("沒有指數資料：超額與獎勵為 null", () => {
    const o = computeOutcome({ code: "buy", price: 100, day: "2026-10-05", preOpen: false }, bars([101]), [], 1)!;
    expect(o.ex).toBeNull();
    expect(o.rw).toBeNull();
  });
});

describe("依據權重（收縮、衰減、門檻、市況分開）", () => {
  it("樣本不足：權重仍算但 active=false，且被收縮向 0", () => {
    const rs = Array.from({ length: 5 }, () => rec({ o5: { brw: 10, rw: 10, ex: 10 } }));
    const [s] = computeBasisStats(rs, "2026-10-05");
    expect(s.n).toBe(5);
    expect(s.active).toBe(false);
    expect(s.avgBuyReward).toBe(10);
    expect(s.weight).toBeCloseTo((5 * 10) / (5 + WEIGHT_PRIOR_STRENGTH), 2);
    expect(toWeightTable([s])).toEqual({});
  });
  it("達門檻才 active，且多頭／空頭分開", () => {
    const rs = [
      ...Array.from({ length: WEIGHT_MIN_SAMPLES }, () => rec({ o5: { brw: 2, rw: 2, ex: 2 } })),
      ...Array.from({ length: 3 }, () => rec({ rg: "bear", o5: { brw: -5, rw: -5, ex: -5 } })),
    ];
    const stats = computeBasisStats(rs, "2026-10-05");
    const bull = stats.find((s) => s.regime === "bull")!;
    const bear = stats.find((s) => s.regime === "bear")!;
    expect(bull.active).toBe(true);
    expect(bear.active).toBe(false);
    expect(bull.weight).toBeCloseTo(1, 2); // 30×2/(30+30)
  });
  it("半衰期：60 個交易日（84 日曆天）後權重減半", () => {
    expect(decayFactor("2026-01-01", "2026-01-01")).toBe(1);
    expect(decayFactor("2026-01-01", "2026-03-26")).toBeCloseTo(0.5, 2);
    expect(WEIGHT_HALF_LIFE_TRADING_DAYS).toBe(60);
  });
  it("learnedScoreAdjustment 預設關閉回 0，打開時加總並封頂", () => {
    const table = { "rsi:≥75\u0000bull": -2, "chase:surge\u0000bull": -2 };
    expect(learnedScoreAdjustment(["rsi:≥75", "chase:surge"], "bull", table)).toBe(0);
    expect(learnedScoreAdjustment(["rsi:≥75", "chase:surge"], "bull", table, true)).toBe(-3);
    expect(learnedScoreAdjustment(["rsi:≥75"], "bear", table, true)).toBe(0);
  });
});

describe("相似案例", () => {
  it("彙總與查詢；< 10 筆標示樣本不足", () => {
    const rs = [rec({ o5: { ret: 3, ex: 1, brw: 0.5 } }), rec({ o5: { ret: -2, ex: -3, brw: -4 } }), rec({ sk: "bear|≥75|≥15" })];
    const t = buildSimilarTable(rs);
    const r = lookupSimilar(feat(), "bull", t)!;
    expect(r.n).toBe(2);
    expect(r.upRatio).toBe(50);
    expect(r.avgExcess).toBe(-1);
    expect(r.insufficient).toBe(true);
    const text = describeSimilarCases(r)!;
    expect(text.startsWith(SIMILAR_CASES_TITLE)).toBe(true);
    expect(text).toContain("樣本 2 筆");
    expect(text).toContain("樣本不足");
  });
  it("0 筆也要照實說樣本不足", () => {
    const text = describeSimilarCases(lookupSimilar(feat(), "range", {}))!;
    expect(text).toContain("0 筆");
    expect(text).toContain("樣本不足");
  });
});

describe("教訓比對與驗證", () => {
  it("RSI≥75＋急漲的建議買進：最多 3 條、有效優先", () => {
    const ls = matchLessons(feat({ rsi: 80, r5: 20 }), "buy");
    expect(ls.length).toBe(LESSONS_MAX_PER_STOCK);
    expect(ls.map((l) => l.id)).toContain("rsi-75");
    expect(ls.every((l) => l.status === "有效")).toBe(true);
    expect(describeLessons(ls)).toContain("樣本 61 筆");
  });
  it("一般情況的先不要買：不附條件型教訓", () => {
    expect(matchLessons(feat(), "avoid")).toEqual([]);
  });
  it("驗證：樣本不足／仍成立／已不成立", () => {
    const hot = (ex: number) => rec({ f: feat({ rsi: 80 }), o5: { ex } });
    const few = validateLessons([hot(-1)]).find((v) => v.id === "rsi-75")!;
    expect(few.verdict).toBe("樣本不足");
    const bad = validateLessons(Array.from({ length: LESSON_VALIDATE_MIN_SAMPLES }, () => hot(2))).find((v) => v.id === "rsi-75")!;
    expect(bad.verdict).toBe("證據已不成立");
    const ok = validateLessons(Array.from({ length: LESSON_VALIDATE_MIN_SAMPLES }, () => hot(-2))).find((v) => v.id === "rsi-75")!;
    expect(ok.verdict).toBe("證據仍成立");
  });
});

describe("成績看板統計", () => {
  it("各結論各期間、待檢討案例", () => {
    const rs = [rec({ o5: { ret: -8, ex: -9, rw: -10 } }), rec({ code: "avoid", o5: { ret: 12, ex: 10, rw: -10 } })];
    const s = summarizeByCode(rs).find((x) => x.code === "buy" && x.h === "5")!;
    expect(s.n).toBe(1);
    expect(s.winRate).toBe(0);
    expect(s.insufficient).toBe(true);
    const cases = reviewCases(rs);
    expect(cases.map((c) => c.kind).sort()).toEqual(["buy-drop", "miss-rise"]);
  });
});
