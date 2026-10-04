import { describe, expect, it } from "vitest";
import type { Chips, ChipsRatios } from "@/lib/data/types";
import { shortMarginRatio } from "@/lib/data/chipsRatios";
import { ratioValue, toListRatios } from "@/lib/chipsRatiosList";
import { holdingStructureCompact, holdingStructureParts } from "@/lib/ai/chipsRatiosWording";
import { describeChipsRatios } from "@/lib/ai/grounding/chipsRatios";
import { holdingStructureFacet, holdingStructureLeans, SHORT_RATIO_INFO_NOTE, type Candidate } from "@/lib/ai/actionScoring";

const chips = (c: Partial<Chips>): Chips => ({ marginDate: "2026-10-02", ...c });

describe("shortMarginRatio：券資比＝融券餘額÷融資餘額", () => {
  it("本期與前一交易日（前日融券÷前日融資）", () => {
    // 今日融資 20,000、融券 1,500；前日融資 20,000-500=19,500、融券 1,500-300=1,200
    const r = shortMarginRatio(chips({ marginBalance: 20_000, marginBalanceChange: 500, shortBalance: 1_500, shortBalanceChange: 300 }));
    expect(r).toEqual({
      date: "2026-10-02",
      balance: 1_500,
      balanceChange: 300,
      shortMarginRatioPercent: 7.5,
      prevShortMarginRatioPercent: 6.15, // 1200/19500=6.1538…
    });
  });

  it("四捨五入到小數第 2 位", () => {
    expect(shortMarginRatio(chips({ marginBalance: 3, shortBalance: 1 }))?.shortMarginRatioPercent).toBe(33.33);
  });

  it("融券為 0 → 0%（有資料，不是查無）", () => {
    expect(shortMarginRatio(chips({ marginBalance: 100, shortBalance: 0 }))?.shortMarginRatioPercent).toBe(0);
  });

  it("融資餘額 0 或缺 → 無法計算回 undefined；缺融券也回 undefined", () => {
    expect(shortMarginRatio(chips({ marginBalance: 0, shortBalance: 10 }))).toBeUndefined();
    expect(shortMarginRatio(chips({ shortBalance: 10 }))).toBeUndefined();
    expect(shortMarginRatio(chips({ marginBalance: 10 }))).toBeUndefined();
    expect(shortMarginRatio(undefined)).toBeUndefined();
  });

  it("前日融資為 0 或缺增減 → 前期 undefined、本期照算", () => {
    const a = shortMarginRatio(chips({ marginBalance: 100, marginBalanceChange: 100, shortBalance: 10, shortBalanceChange: 0 }));
    expect(a?.shortMarginRatioPercent).toBe(10);
    expect(a?.prevShortMarginRatioPercent).toBeUndefined();
    const b = shortMarginRatio(chips({ marginBalance: 100, shortBalance: 10, shortBalanceChange: 2 }));
    expect(b?.prevShortMarginRatioPercent).toBeUndefined();
  });
});

const shortOnly: ChipsRatios = {
  short: { date: "2026-10-02", balance: 1500, balanceChange: 300, shortMarginRatioPercent: 7.5, prevShortMarginRatioPercent: 6.15 },
};

describe("券資比在列表精簡格式與排序值", () => {
  it("toListRatios 輸出 [本期, 前期]，ratioValue 取本期；沒有這項回 null", () => {
    expect(toListRatios(shortOnly)?.short).toEqual([7.5, 6.15]);
    expect(ratioValue(shortOnly, "short")).toBe(7.5);
    expect(ratioValue(shortOnly, "margin")).toBeNull();
    expect(ratioValue(null, "short")).toBeNull();
  });
});

describe("券資比在 AI 文字", () => {
  it("今日快報精簡行與體檢表單行都帶升降幅度", () => {
    expect(holdingStructureCompact(shortOnly)).toBe("券資比7.50%（較前一交易日上升 1.35 個百分點）");
    expect(holdingStructureParts(shortOnly)?.short).toBe("券資比（2026-10-02）7.50%，較前一交易日上升 1.35 個百分點（前一交易日6.15%）");
    expect(holdingStructureParts({ margin: { balance: 1, utilizationPercent: 1 } })?.short).toBe("券資比：查無資料");
  });

  it("個股資料區塊含券資比與融券餘額增減", () => {
    const text = describeChipsRatios(shortOnly)!;
    expect(text.startsWith("籌碼比例（")).toBe(true);
    expect(text).toContain("- 券資比（融券餘額÷融資餘額，2026-10-02）：7.50%，前一交易日 6.15%，較前一交易日上升 1.35 個百分點；融券餘額 1,500 張，較前一交易日增加 300 張");
    expect(describeChipsRatios({ margin: { balance: 1, utilizationPercent: 1 } })).toContain("- 券資比：資料暫缺");
  });

  it("持股結構面：券資比只列資訊不計分", () => {
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
    expect(facet.detail).toContain(`券資比（2026-10-02）7.50%`);
    expect(facet.detail).toContain(SHORT_RATIO_INFO_NOTE);
  });
});
