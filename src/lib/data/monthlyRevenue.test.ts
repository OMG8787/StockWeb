import { describe, expect, it } from "vitest";
import { formatRevenueMom, parseMonthlyRevenueRow } from "./monthlyRevenue";

// 營收月增率（2026-10-07 使用者回報：「營收年增以外，還可以增加月增」）。
// 欄位取自 TWSE／TPEx／興櫃月營收開放資料（三者同名）的「營業收入-上月比較增減(%)」。
describe("parseMonthlyRevenueRow", () => {
  it("同時解析年增率、月增率、期間，四捨五入到兩位", () => {
    const r = parseMonthlyRevenueRow({
      公司代號: "1101",
      資料年月: "11508",
      "營業收入-上月比較增減(%)": "-1.6630332295967223",
      "營業收入-去年同月增減(%)": "10.649053245020621",
    });
    expect(r).toEqual({ monthlyRevenueYoyPercent: 10.65, monthlyRevenueMomPercent: -1.66, monthlyRevenuePeriod: "2026年8月" });
  });

  it("月增率欄位缺漏或非數字時只少月增率，年增率照給", () => {
    const r = parseMonthlyRevenueRow({ 公司代號: "1101", 資料年月: "11508", "營業收入-去年同月增減(%)": "3.5" });
    expect(r).toEqual({ monthlyRevenueYoyPercent: 3.5, monthlyRevenuePeriod: "2026年8月" });
    expect(r).not.toHaveProperty("monthlyRevenueMomPercent");
    const r2 = parseMonthlyRevenueRow({ 公司代號: "1101", 資料年月: "11508", "營業收入-上月比較增減(%)": "", "營業收入-去年同月增減(%)": "3.5" });
    expect(r2).not.toHaveProperty("monthlyRevenueMomPercent");
  });

  it("沒有公司代號或年增率不是數字就略過（維持舊行為）", () => {
    expect(parseMonthlyRevenueRow({ 資料年月: "11508", "營業收入-去年同月增減(%)": "3.5" })).toBeNull();
    expect(parseMonthlyRevenueRow({ 公司代號: "1101", 資料年月: "11508", "營業收入-去年同月增減(%)": "" })).toBeNull();
  });
});

describe("formatRevenueMom", () => {
  it("正值帶 +、負值帶 -、0 帶 +、沒值回 null", () => {
    expect(formatRevenueMom({ monthlyRevenueMomPercent: 3.8 })).toBe("+3.8%");
    expect(formatRevenueMom({ monthlyRevenueMomPercent: -1.66 })).toBe("-1.66%");
    expect(formatRevenueMom({ monthlyRevenueMomPercent: 0 })).toBe("+0%");
    expect(formatRevenueMom({})).toBeNull();
    expect(formatRevenueMom(null)).toBeNull();
  });
});
