import { describe, expect, it } from "vitest";
import { buildRatingLogEntry, ratingSession } from "@/lib/ai/ratingLog";
import { computeSiteRating } from "@/lib/ai/siteRating";
import type { StockRatingResult } from "@/lib/ai/stockRating";

describe("ratingLog", () => {
  it("時段對照：盤中／盤後定價／收盤後與週末＝明日開盤", () => {
    expect(ratingSession("intraday")).toBe("盤中");
    expect(ratingSession("after-hours-fixed")).toBe("盤後定價");
    expect(ratingSession("after-close")).toBe("明日開盤");
    expect(ratingSession("weekend")).toBe("明日開盤");
    expect(ratingSession("pre-open")).toBe("開盤前");
  });

  it("一筆紀錄帶台北日期、時段、結論、五面向與來源", () => {
    const facets = [
      { name: "技術面", verdict: "支持" as const, detail: "" },
      { name: "籌碼面", verdict: "支持" as const, detail: "" },
      { name: "基本面（估值）", verdict: "中性" as const, detail: "" },
    ];
    const rating = computeSiteRating({ facets, supportCount: 2, againstCount: 0, signals: [], framework: null });
    const r: StockRatingResult = {
      symbol: "2330", market: "TW", name: "台積電", price: 1000, rating, facets, framework: null, computedAt: "",
    };
    // 2026-10-05（一）10:00 台北＝02:00 UTC
    const e = buildRatingLogEntry(r, "stock-button", new Date("2026-10-05T02:00:00Z"));
    expect(e.day).toBe("2026-10-05");
    expect(e.session).toBe("盤中");
    expect(e.code).toBe("buy");
    expect(e.facets).toEqual({ 技術面: "支持", 籌碼面: "支持", 基本面: "中性" });
    expect(e.source).toBe("stock-button");
  });
});
