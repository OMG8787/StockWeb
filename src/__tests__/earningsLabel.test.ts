import { describe, expect, it } from "vitest";
import { twQuarterlyEpsPeriodLabel } from "@/lib/data/earningsLabel";

describe("twQuarterlyEpsPeriodLabel", () => {
  it("Q1 本身就是單季，維持原樣", () => {
    expect(twQuarterlyEpsPeriodLabel("115", "1")).toBe("115年Q1");
    expect(twQuarterlyEpsPeriodLabel(115, 1)).toBe("115年Q1");
  });

  it("Q2~Q4 是年度累計，標 Q1～Qn累計", () => {
    expect(twQuarterlyEpsPeriodLabel("115", "2")).toBe("115年Q1～Q2累計");
    expect(twQuarterlyEpsPeriodLabel(115, 3)).toBe("115年Q1～Q3累計");
    expect(twQuarterlyEpsPeriodLabel("114", "4")).toBe("114年Q1～Q4累計");
  });

  it("季別前後有空白也能判斷", () => {
    expect(twQuarterlyEpsPeriodLabel("115", " 2 ")).toBe("115年Q1～Q2累計");
  });

  it("不是 1~4 的季別不加累計（照原樣標）", () => {
    expect(twQuarterlyEpsPeriodLabel("115", "5")).toBe("115年Q5");
  });
});
