import { describe, expect, it } from "vitest";
import { aiReward, summarizeChampionChallenger } from "@/lib/ai/learning/championChallenger";
import type { EvalRecord } from "@/lib/ai/learning/types";

const rec = (sym: string, code: EvalRecord["code"], ex: number, ai?: { code: EvalRecord["code"]; delta: number }): EvalRecord => ({
  at: "2026-10-05T02:00:00Z",
  day: "2026-10-05",
  sym,
  name: sym,
  code,
  price: 100,
  rg: "bull",
  bases: [],
  sk: null,
  o: { "5": { end: "2026-10-12", ret: ex, idx: 0, ex, mdd: 0, brw: ex - 0.585, rw: code === "buy" ? ex - 0.585 : ex > 3 || ex < 0 ? -ex : 0 } },
  ...(ai ? { ai } : {}),
});

describe("冠軍／挑戰者", () => {
  it("AI 調降一檔後來大跌的建議買進 → AI 獎勵較高", () => {
    const r = rec("A", "buy", -5, { code: "buy-on-pullback", delta: -1 });
    expect(r.o["5"]!.rw).toBeCloseTo(-5.585);
    expect(aiReward(r, "5")).toBe(5);
    const cc = summarizeChampionChallenger([r, rec("B", "buy", 2, { code: "buy", delta: 0 }), rec("C", "avoid", 1)]);
    const row5 = cc.rows.find((x) => x.h === "5")!;
    expect(row5.n).toBe(2);
    expect(row5.adjustedN).toBe(1);
    expect(row5.ai.avgReward!).toBeGreaterThan(row5.program.avgReward!);
    expect(cc.promotion.ready).toBe(false);
    expect(cc.rows.find((x) => x.h === "1")!.n).toBe(0);
  });
});
