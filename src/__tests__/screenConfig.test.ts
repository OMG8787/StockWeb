import { describe, expect, it } from "vitest";
import { describeScreen, normalizeScreen, periodDays, slicePosition } from "@/lib/strategy/screenConfig";
import { normalizeStrategyConfig } from "@/lib/strategy/engine";

describe("股票篩選判斷設定", () => {
  it("整理設定：不合法的值用預設、未知來源回 null", () => {
    expect(normalizeScreen({ source: "metric", metric: "nope", position: "xx", count: 7 })).toEqual({ source: "metric", metric: "volume_today", position: "top", count: 20 });
    expect(normalizeScreen({ source: "ai", mode: "rating_buy", count: 30 })).toEqual({ source: "ai", mode: "rating_buy", count: 30 });
    expect(normalizeScreen({ source: "watchlist" })).toEqual({ source: "watchlist" });
    expect(normalizeScreen({ source: "x" })).toBeNull();
    expect(normalizeScreen(null)).toBeNull();
  });

  it("前段／中段／後段取法", () => {
    const desc = Array.from({ length: 11 }, (_, i) => 10 - i); // 10..0
    expect(slicePosition(desc, "top", 3)).toEqual([10, 9, 8]);
    expect(slicePosition(desc, "bottom", 3)).toEqual([0, 1, 2]); // 後段從最低開始
    expect(slicePosition(desc, "middle", 3)).toEqual([6, 5, 4]);
    expect(slicePosition([1, 2], "middle", 5)).toEqual([1, 2]);
  });

  it("當週／當月的交易日數估算", () => {
    expect(periodDays("week", "2026-10-08")).toBe(4); // 星期四
    expect(periodDays("week", "2026-10-05")).toBe(1); // 星期一
    expect(periodDays("month", "2026-10-08")).toBe(6); // 10/1(四)、2(五)、5～8
  });

  it("說明文字、策略設定帶著篩選", () => {
    expect(describeScreen({ source: "metric", metric: "volume_5d", position: "middle", count: 20 })).toBe("成交量（5 日平均） 中間 20 名");
    expect(describeScreen(null)).toBe("未設定股票篩選");
    const cfg = normalizeStrategyConfig({ screen: { source: "watchlist" } }, new Set());
    expect(cfg.screen).toEqual({ source: "watchlist" });
    expect(normalizeStrategyConfig({}, new Set()).screen).toBeNull();
  });
});
