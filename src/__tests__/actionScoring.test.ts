import { describe, expect, it } from "vitest";
import type { ChipsRatios } from "@/lib/data/types";
import {
  HOLDING_CHANGE_MIN_POINTS,
  holdingStructureFacet,
  holdingStructureLeans,
  MARGIN_UTIL_HIGH,
  MARGIN_UTIL_LOW,
  MARGIN_UTIL_SURGE_POINTS,
  type Candidate,
} from "@/lib/ai/actionScoring";

function candidate(chipsRatios: ChipsRatios | null): Candidate {
  return {
    symbol: "2330",
    name: "台積電",
    price: 1000,
    changePercent: 1,
    sources: [],
    signals: [],
    chips: null,
    chipsRatios,
    fundamentals: null,
    earnings: null,
    announcements: [],
    headlines: [],
  };
}

const major = (cur: number, prev?: number): NonNullable<ChipsRatios["majorHolders"]> => ({
  date: "2026-10-02",
  holders: 100,
  shares: 1_000_000,
  holdingPercent: cur,
  ...(prev != null ? { prevDate: "2026-09-25", prevHoldingPercent: prev } : {}),
});
const foreign = (cur: number, prev?: number): NonNullable<ChipsRatios["foreign"]> => ({
  date: "2026-10-02",
  heldShares: 1_000_000,
  holdingPercent: cur,
  ...(prev != null ? { prevDate: "2026-10-01", prevHoldingPercent: prev } : {}),
});
const margin = (cur: number, prev?: number): NonNullable<ChipsRatios["margin"]> => ({
  date: "2026-10-02",
  balance: 1000,
  utilizationPercent: cur,
  ...(prev != null ? { prevUtilizationPercent: prev } : {}),
});

describe("holdingStructureLeans：大戶／外資（升降門檻）", () => {
  it("上升達門檻 +1、下降達門檻 -1、不到門檻或沒有前期 0", () => {
    expect(holdingStructureLeans({ majorHolders: major(70.5, 70) }).major).toBe(1);
    expect(holdingStructureLeans({ majorHolders: major(69.5, 70) }).major).toBe(-1);
    expect(holdingStructureLeans({ majorHolders: major(70.04, 70) }).major).toBe(0);
    expect(holdingStructureLeans({ majorHolders: major(70.5) }).major).toBe(0);
    expect(holdingStructureLeans({}).major).toBe(0);
  });

  it("剛好等於門檻（0.05）算升降；浮點尾數 70.05-70 也要算上升", () => {
    expect(HOLDING_CHANGE_MIN_POINTS).toBe(0.05);
    expect(holdingStructureLeans({ majorHolders: major(70.05, 70) }).major).toBe(1);
    expect(holdingStructureLeans({ majorHolders: major(69.95, 70) }).major).toBe(-1);
    expect(holdingStructureLeans({ foreign: foreign(30.05, 30) }).foreign).toBe(1);
    expect(holdingStructureLeans({ foreign: foreign(29.96, 30) }).foreign).toBe(0);
  });
});

describe("holdingStructureLeans：融資使用率", () => {
  it(`達 ${MARGIN_UTIL_HIGH}% 扣分（含邊界），低於 ${MARGIN_UTIL_LOW}% 加分（邊界不算）`, () => {
    expect(holdingStructureLeans({ margin: margin(MARGIN_UTIL_HIGH) }).margin).toBe(-1);
    expect(holdingStructureLeans({ margin: margin(MARGIN_UTIL_HIGH - 0.01) }).margin).toBe(0);
    expect(holdingStructureLeans({ margin: margin(MARGIN_UTIL_LOW - 0.01) }).margin).toBe(1);
    expect(holdingStructureLeans({ margin: margin(MARGIN_UTIL_LOW) }).margin).toBe(0);
  });

  it("中間水位：較前一交易日下降加分、上升不加分、單日攀升達門檻扣分（扣分優先）", () => {
    expect(holdingStructureLeans({ margin: margin(45, 45.5) }).margin).toBe(1);
    expect(holdingStructureLeans({ margin: margin(45, 44.5) }).margin).toBe(0);
    expect(holdingStructureLeans({ margin: margin(45, 45 - MARGIN_UTIL_SURGE_POINTS) }).margin).toBe(-1);
    // 水位很低但一天暴衝 2 個百分點 → 仍然扣分，不因絕對水位低而加分
    expect(holdingStructureLeans({ margin: margin(20, 18) }).margin).toBe(-1);
    expect(holdingStructureLeans({ margin: margin(20, 19) }).margin).toBe(1);
  });
});

describe("holdingStructureFacet 判定", () => {
  it("沒有 chipsRatios → 無資料", () => {
    expect(holdingStructureFacet(candidate(null)).verdict).toBe("無資料");
  });

  it("三項裡兩項加分且零扣分 → 支持", () => {
    const f = holdingStructureFacet(candidate({ majorHolders: major(71, 70), foreign: foreign(31, 30) }));
    expect(f.verdict).toBe("支持");
    expect(f.detail).toContain("（加分）");
  });

  it("兩項加分但有一項扣分 → 中性（支持要求零扣分）", () => {
    const f = holdingStructureFacet(
      candidate({ majorHolders: major(71, 70), foreign: foreign(31, 30), margin: margin(65) })
    );
    expect(f.verdict).toBe("中性");
  });

  it("只有一項加分 → 中性", () => {
    expect(holdingStructureFacet(candidate({ majorHolders: major(71, 70) })).verdict).toBe("中性");
  });

  it("兩項扣分 → 不支持；只有一項扣分 → 中性", () => {
    const against = holdingStructureFacet(candidate({ majorHolders: major(69, 70), foreign: foreign(29, 30) }));
    expect(against.verdict).toBe("不支持");
    expect(against.detail).toContain("（扣分）");
    expect(holdingStructureFacet(candidate({ majorHolders: major(69, 70) })).verdict).toBe("中性");
  });

  it("大戶沒有上一週 → 不計分，但仍有資料（中性，不是無資料）", () => {
    expect(holdingStructureFacet(candidate({ majorHolders: major(71) })).verdict).toBe("中性");
  });

  it("融資高檔註記與扣分標籤一致", () => {
    const f = holdingStructureFacet(candidate({ margin: margin(70, 70) }));
    expect(f.detail).toContain(`偏高（≥${MARGIN_UTIL_HIGH}%`);
    expect(f.detail).toContain("（扣分）");
  });
});
