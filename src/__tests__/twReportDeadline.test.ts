import { describe, expect, it } from "vitest";
import { formatTwReportDeadline, nextTwReportDeadline, parseTwEpsPeriod } from "@/lib/data/twReportDeadline";
import { classifyTwReportCategory } from "@/lib/data/twCompanyProfile";
import { resolveMarketCap } from "@/lib/data/marketCap";
import { formatMarketCap } from "@/lib/format";

// 台北時間正午，避免時區邊界干擾
const at = (iso: string) => new Date(`${iso}T04:00:00Z`);

describe("parseTwEpsPeriod", () => {
  it("單季與累計標籤都能解析", () => {
    expect(parseTwEpsPeriod("115年Q1")).toEqual({ fiscalYear: 2026, quarter: 1 });
    expect(parseTwEpsPeriod("115年Q1～Q2累計")).toEqual({ fiscalYear: 2026, quarter: 2 });
    expect(parseTwEpsPeriod("2026 Q2")).toBeNull();
    expect(parseTwEpsPeriod(undefined)).toBeNull();
  });
});

describe("nextTwReportDeadline", () => {
  it("一般公司：已公布 Q2，10/5 → Q3 11/14", () => {
    expect(nextTwReportDeadline("general", "115年Q1～Q2累計", at("2026-10-05"))).toEqual({ date: "2026-11-14", period: "115年Q3" });
  });
  it("提早公布完 Q3 → 下一份是年報（次年 3/31）", () => {
    expect(nextTwReportDeadline("general", "115年Q1～Q3累計", at("2026-11-01"))).toEqual({ date: "2027-03-31", period: "115年度年報" });
  });
  it("年報之後 → 次年 Q1", () => {
    expect(nextTwReportDeadline("general", "115年Q1～Q4累計", at("2027-04-02"))).toEqual({ date: "2027-05-15", period: "116年Q1" });
  });
  it("推出來的期限已過（資料未更新）→ 改用今天以後最近的期限", () => {
    expect(nextTwReportDeadline("general", "115年Q1", at("2026-08-20"))).toEqual({ date: "2026-11-14", period: "115年Q3" });
  });
  it("沒有 EPS 季別 → 依日期", () => {
    expect(nextTwReportDeadline("general", undefined, at("2026-01-10"))).toEqual({ date: "2026-03-31", period: "114年度年報" });
    expect(nextTwReportDeadline("general", undefined, at("2026-11-14"))).toEqual({ date: "2026-11-14", period: "115年Q3" });
    expect(nextTwReportDeadline("general", undefined, at("2026-11-15"))).toEqual({ date: "2027-03-31", period: "115年度年報" });
  });
  it("金控 Q1 5/30、Q2 8/31、Q3 11/29", () => {
    expect(nextTwReportDeadline("financialHolding", "114年Q1～Q4累計", at("2026-04-10")).date).toBe("2026-05-30");
    expect(nextTwReportDeadline("financialHolding", "115年Q1", at("2026-06-10")).date).toBe("2026-08-31");
    expect(nextTwReportDeadline("financialHolding", "115年Q1～Q2累計", at("2026-10-05")).date).toBe("2026-11-29");
  });
  it("金融保險業／外國企業：Q2 8/31，Q3 仍 11/14", () => {
    expect(nextTwReportDeadline("financial", "115年Q1", at("2026-06-10")).date).toBe("2026-08-31");
    expect(nextTwReportDeadline("foreign", "115年Q1", at("2026-06-10")).date).toBe("2026-08-31");
    expect(nextTwReportDeadline("foreign", "115年Q1～Q2累計", at("2026-10-05")).date).toBe("2026-11-14");
  });
  it("顯示寫法", () => {
    expect(formatTwReportDeadline({ date: "2026-11-14", period: "115年Q3" })).toBe("依法最晚 2026/11/14 前公布（115年Q3）");
  });
});

describe("classifyTwReportCategory", () => {
  it("金控／金融保險業／外國企業／一般", () => {
    expect(classifyTwReportCategory("富邦金融控股股份有限公司", "17", "－ ")).toBe("financialHolding");
    expect(classifyTwReportCategory("彰化商業銀行股份有限公司", "17", "－ ")).toBe("financial");
    expect(classifyTwReportCategory("某某控股股份有限公司", "24", "開曼群島")).toBe("foreign");
    expect(classifyTwReportCategory("台灣積體電路製造股份有限公司", "24", "－ ")).toBe("general");
  });
});

describe("resolveMarketCap", () => {
  it("美股：上游市值原樣回傳", () => {
    expect(resolveMarketCap({ marketCap: 3e12 }, 200)).toBe(3e12);
  });
  it("台股：現價×股數；缺任一回 undefined", () => {
    expect(resolveMarketCap({ sharesOutstanding: 25_932_370_067 }, 1000)).toBe(25_932_370_067_000);
    expect(resolveMarketCap({ peRatio: 10 }, 1000)).toBeUndefined();
    expect(resolveMarketCap({ sharesOutstanding: 100 }, 0)).toBeUndefined();
    expect(resolveMarketCap(null, 100)).toBeUndefined();
  });
});

describe("formatMarketCap", () => {
  it("台股用兆／億，美股維持 T/B/M", () => {
    expect(formatMarketCap(25_932_370_067_000, "TWD")).toBe("25.93兆元");
    expect(formatMarketCap(8_868_465_000, "TWD")).toBe("88.7億元");
    expect(formatMarketCap(150_000_000_000, "TWD")).toBe("1500億元");
    expect(formatMarketCap(3.1e12, "USD")).toBe("$3.10T");
    expect(formatMarketCap(2.5e9, "USD")).toBe("$2.50B");
  });
});
