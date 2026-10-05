import { describe, expect, it } from "vitest";
import { describeAiView, parseAiJudgments, shiftCode } from "@/lib/ai/learning/aiAdjust";
import type { RatingCode } from "@/lib/ai/siteRating";

describe("AI 判斷層", () => {
  it("等級位移到頂到底就停", () => {
    expect(shiftCode("buy", 1)).toBe("buy");
    expect(shiftCode("avoid", -1)).toBe("avoid");
    expect(shiftCode("buy-on-pullback", 1)).toBe("buy");
    expect(shiftCode("buy-on-pullback", -1)).toBe("avoid");
  });

  it("解析 JSON、只收名單內代號、到頂的調升記為維持", () => {
    const bases = new Map<string, RatingCode>([
      ["2330", "buy"],
      ["2303", "buy-on-pullback"],
    ]);
    const m = parseAiJudgments(
      '[{"symbol":"2330","adjust":"up","reason":"利多","confidence":"高"},{"symbol":"2303","adjust":"down","reason":"重訊：減資","confidence":"低"},{"symbol":"9999","adjust":"up","reason":"x"}]',
      bases
    );
    expect(m.get("2330")).toMatchObject({ delta: 0, code: "buy" });
    expect(m.get("2303")).toMatchObject({ delta: -1, code: "avoid", confidence: "低" });
    expect(m.has("9999")).toBe(false);
    expect(parseAiJudgments("不是 JSON", bases).size).toBe(0);
  });

  it("AI 看法行：有調整才有、評等改變後不再顯示", () => {
    const m = parseAiJudgments('[{"symbol":"2303","adjust":"down","reason":"重訊：減資。","confidence":"中"}]', new Map([["2303", "buy-on-pullback" as RatingCode]]));
    const j = m.get("2303")!;
    expect(describeAiView(j, "buy-on-pullback")).toBe("AI 看法：調降一級（建議先不要買），因為重訊：減資（把握：中；僅供參考，結論仍以本站綜合評等為準）");
    expect(describeAiView(j, "buy")).toBeNull();
    expect(describeAiView({ ...j, delta: 0 }, "buy-on-pullback")).toBeNull();
  });
});
