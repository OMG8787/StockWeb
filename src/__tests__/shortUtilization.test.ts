import { describe, expect, it } from "vitest";
import type { Chips, ChipsRatios } from "@/lib/data/types";
import { shortUtilization } from "@/lib/data/chipsRatios";
import { ratioValue, toListRatios } from "@/lib/chipsRatiosList";
import { holdingStructureCompact, holdingStructureParts } from "@/lib/ai/chipsRatiosWording";
import { describeChipsRatios } from "@/lib/ai/grounding/chipsRatios";
import { holdingStructureFacet, holdingStructureLeans, SHORT_UTILIZATION_INFO_NOTE, type Candidate } from "@/lib/ai/actionScoring";

const chips = (c: Partial<Chips>): Chips => ({ marginDate: "2026-10-02", ...c });

describe("shortUtilization：融券使用率＝融券餘額÷融券限額", () => {
  it("本期與前一交易日（前日融券÷同一個限額）——6488 2026-10-02 官方資料對帳", () => {
    // TPEx：ShortSaleBalance 714、前日 535、ShortSaleQuota 132028；官方 ShortSaleUtilizationRate 0.54
    const r = shortUtilization(chips({ shortBalance: 714, shortBalanceChange: 179, shortQuota: 132_028 }));
    expect(r).toEqual({
      date: "2026-10-02",
      balance: 714,
      balanceChange: 179,
      utilizationPercent: 0.54, // 714/132028=0.5408…
      prevUtilizationPercent: 0.41, // 535/132028=0.4052…
    });
  });

  it("四捨五入到小數第 2 位；跟融資餘額無關", () => {
    expect(shortUtilization(chips({ shortBalance: 1, shortQuota: 3 }))?.utilizationPercent).toBe(33.33);
    expect(shortUtilization(chips({ shortBalance: 1, shortQuota: 3, marginBalance: 0 }))?.utilizationPercent).toBe(33.33);
  });

  it("融券為 0 → 0%（有資料，不是查無）", () => {
    expect(shortUtilization(chips({ shortBalance: 0, shortQuota: 100 }))?.utilizationPercent).toBe(0);
  });

  it("限額 0 或缺 → 無法計算回 undefined（不拿融資餘額頂替）；缺融券也回 undefined", () => {
    expect(shortUtilization(chips({ shortBalance: 10, shortQuota: 0 }))).toBeUndefined();
    expect(shortUtilization(chips({ shortBalance: 10, marginBalance: 100, marginQuota: 1000 }))).toBeUndefined();
    expect(shortUtilization(chips({ shortQuota: 10 }))).toBeUndefined();
    expect(shortUtilization(undefined)).toBeUndefined();
  });

  it("缺前日增減 → 前期 undefined、本期照算", () => {
    const r = shortUtilization(chips({ shortBalance: 10, shortQuota: 100 }));
    expect(r?.utilizationPercent).toBe(10);
    expect(r?.prevUtilizationPercent).toBeUndefined();
  });
});

const shortOnly: ChipsRatios = {
  short: { date: "2026-10-02", balance: 1500, balanceChange: 300, utilizationPercent: 7.5, prevUtilizationPercent: 6.15 },
};

describe("融券使用率在列表精簡格式與排序值", () => {
  it("toListRatios 輸出 [本期, 前期]，ratioValue 取本期；沒有這項回 null", () => {
    expect(toListRatios(shortOnly)?.short).toEqual([7.5, 6.15]);
    expect(ratioValue(shortOnly, "short")).toBe(7.5);
    expect(ratioValue(shortOnly, "margin")).toBeNull();
    expect(ratioValue(null, "short")).toBeNull();
  });

  it("沒有前期時列表前期是 null", () => {
    expect(toListRatios({ short: { balance: 1, utilizationPercent: 2 } })?.short).toEqual([2, null]);
  });
});

describe("融券使用率在 AI 文字", () => {
  it("今日快報精簡行與體檢表單行都帶升降幅度", () => {
    expect(holdingStructureCompact(shortOnly)).toBe("融券使用率7.50%（較前一交易日上升 1.35 個百分點）");
    expect(holdingStructureParts(shortOnly)?.short).toBe("融券使用率（2026-10-02）7.50%，較前一交易日上升 1.35 個百分點（前一交易日6.15%）");
    expect(holdingStructureParts({ margin: { balance: 1, utilizationPercent: 1 } })?.short).toBe("融券使用率：查無資料");
  });

  it("個股資料區塊含融券使用率公式與融券餘額增減", () => {
    const text = describeChipsRatios(shortOnly)!;
    expect(text.startsWith("籌碼比例（")).toBe(true);
    expect(text).toContain("- 融券使用率（融券餘額÷融券限額，2026-10-02）：7.50%，前一交易日 6.15%，較前一交易日上升 1.35 個百分點；融券餘額 1,500 張，較前一交易日增加 300 張");
    expect(describeChipsRatios({ margin: { balance: 1, utilizationPercent: 1 } })).toContain("- 融券使用率：資料暫缺");
    expect(text).not.toContain("券資比");
  });

  it("持股結構面：融券使用率只列資訊不計分", () => {
    const c: Candidate = {
      symbol: "2330",
      name: "台積電",
      price: 1000,
      changePercent: 1,
      sources: [],
      signals: [],
      chips: null,
      chipsRatios: shortOnly,
      fundamentals: null,
      earnings: null,
      announcements: [],
      headlines: [],
    };
    expect(holdingStructureLeans(shortOnly)).toEqual({ major: 0, foreign: 0, margin: 0 });
    const facet = holdingStructureFacet(c);
    expect(facet.verdict).toBe("中性");
    expect(facet.detail).toContain(`融券使用率（2026-10-02）7.50%`);
    expect(facet.detail).toContain(SHORT_UTILIZATION_INFO_NOTE);
  });
});
