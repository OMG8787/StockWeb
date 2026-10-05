import { describe, expect, it } from "vitest";
import { marketReturnPct } from "@/lib/ai/learning/regime";

describe("marketReturnPct（弱市況提示：加權近 60 日報酬）", () => {
  it("60 個交易日前到今天的報酬", () => {
    const closes = [100, ...Array.from({ length: 59 }, () => 101), 103];
    expect(marketReturnPct(closes)).toBeCloseTo(3, 6);
  });
  it("日K不足回 null", () => {
    expect(marketReturnPct(Array.from({ length: 60 }, () => 100))).toBeNull();
  });
});
