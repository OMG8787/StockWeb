import { describe, expect, it } from "vitest";
import {
  ensureMarginSignalMentioned,
  MARGIN_SIGNAL_APPENDIX_TITLE,
  changePercentOnDate,
  computeMarginSignal,
  describeMarginSignal,
  marginDataMatchesPrice,
  marginSignalLine,
} from "@/lib/ai/marginSignal";
import { MARGIN_SIGNAL_TITLE } from "@/lib/ai/marginSignalData";

// 融資 10,000 張、增加 500 張（前日 9,500 → +5.3%）、融券 200 張增加 40 張（前日 160 → +25%）
const base = { marginBalance: 10_000, marginBalanceChange: 500, shortBalance: 200, shortBalanceChange: 40 };

describe("融資融券組合判讀 computeMarginSignal", () => {
  it("漲＋融資大增 → 追高風險（優先於可能軋空）", () => {
    const s = computeMarginSignal({ ...base, changePercent: 2.3 });
    expect(s?.code).toBe("chase");
    expect(s?.numbers).toContain("股價+2.3%");
    expect(s?.numbers).toContain("融資+5.3%（+500張）");
    expect(s?.numbers).toContain("融券+25%（+40張）");
  });
  it("漲＋融券增（融資平） → 可能軋空", () => {
    expect(computeMarginSignal({ ...base, marginBalanceChange: 10, changePercent: 1.5 })?.code).toBe("squeeze");
  });
  it("跌＋融資大減 → 籌碼沉澱", () => {
    expect(computeMarginSignal({ ...base, marginBalanceChange: -400, shortBalanceChange: 0, changePercent: -2 })?.code).toBe("settle");
  });
  it("跌＋融券增（融資沒大減） → 空方佔優", () => {
    expect(computeMarginSignal({ ...base, marginBalanceChange: 0, changePercent: -1.2 })?.code).toBe("bearish");
  });
  it("跌＋融資大減同時融券增 → 籌碼沉澱優先", () => {
    expect(computeMarginSignal({ ...base, marginBalanceChange: -400, changePercent: -3 })?.code).toBe("settle");
  });
  it("漲跌幅不到 1% → 中性", () => {
    expect(computeMarginSignal({ ...base, changePercent: 0.9 })?.code).toBe("neutral");
    expect(computeMarginSignal({ ...base, changePercent: -0.9 })?.code).toBe("neutral");
  });
  it("融資增幅不到 3% 或不到 100 張 → 不算大增", () => {
    expect(computeMarginSignal({ ...base, marginBalanceChange: 250, shortBalanceChange: 0, changePercent: 2 })?.code).toBe("neutral"); // 2.6%
    expect(computeMarginSignal({ marginBalance: 1_000, marginBalanceChange: 90, changePercent: 2 })?.code).toBe("neutral"); // 9.9% 但只有 90 張
  });
  it("融券增幅不到 10% 或不到 30 張 → 不算增加", () => {
    expect(computeMarginSignal({ marginBalance: 100, marginBalanceChange: 0, shortBalance: 1_000, shortBalanceChange: 90, changePercent: 2 })?.code).toBe("neutral");
    expect(computeMarginSignal({ marginBalance: 100, marginBalanceChange: 0, shortBalance: 100, shortBalanceChange: 20, changePercent: 2 })?.code).toBe("neutral"); // +25% 但只有 20 張
  });
  it("門檻邊界：剛好 +3%（且 ≥100 張）算大增", () => {
    // 前日 10,000 → 今日 10,300：+300 張、+3.0%
    expect(computeMarginSignal({ marginBalance: 10_300, marginBalanceChange: 300, changePercent: 1 })?.code).toBe("chase");
  });
  it("前日餘額為 0（從零新增）算不出百分比 → 不判為大增", () => {
    expect(computeMarginSignal({ marginBalance: 500, marginBalanceChange: 500, changePercent: 3 })?.code).toBe("neutral");
  });
  it("缺價格或缺融資融券 → null（無法判讀，不等於中性）", () => {
    expect(computeMarginSignal({ ...base, changePercent: null })).toBeNull();
    expect(computeMarginSignal({ changePercent: 2 })).toBeNull();
  });
  it("只有融資沒有融券也能判讀", () => {
    expect(computeMarginSignal({ marginBalance: 10_000, marginBalanceChange: 500, changePercent: 2 })?.code).toBe("chase");
  });
});

describe("describeMarginSignal／marginSignalLine", () => {
  it("中性與 null 不產生文字（省 token）", () => {
    expect(describeMarginSignal(null)).toBeNull();
    expect(describeMarginSignal(computeMarginSignal({ ...base, changePercent: 0.2 }))).toBeNull();
  });
  it("非中性文字帶標題、訊號名、依據數字", () => {
    const t = describeMarginSignal(computeMarginSignal({ ...base, changePercent: 2.3 }), "10/6單日數字");
    expect(t).toContain(MARGIN_SIGNAL_TITLE);
    expect(t).toContain("【追高風險】");
    expect(t).toContain("融資+5.3%（+500張）");
  });
  // 週二 15:30 台北＝收盤後；融資融券還是昨天的 → 對不上、沒有日K就不判讀
  const afterClose = new Date("2026-10-06T07:30:00Z");
  const chips = { ...base, marginDate: "2026-10-05" };
  it("收盤後融資融券還是前一天 → 沒日K不判讀；有日K改用融資融券那天的漲跌幅", () => {
    expect(marginSignalLine(chips, 2.3, { now: afterClose })).toBeNull();
    const candles = [
      { time: "2026-10-02", open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { time: "2026-10-05", open: 100, high: 103, low: 100, close: 102, volume: 1 },
      { time: "2026-10-06", open: 102, high: 102, low: 90, close: 91, volume: 1 },
    ];
    const line = marginSignalLine(chips, -10.8, { now: afterClose, candles });
    expect(line).toContain("【追高風險】");
    expect(line).toContain("股價+2%");
  });
  it("融資融券日期＝今天（收盤後 21 點後）→ 直接用報價漲跌幅", () => {
    const night = new Date("2026-10-06T14:00:00Z"); // 22:00 台北
    expect(marginSignalLine({ ...base, marginDate: "2026-10-06" }, 2.3, { now: night })).toContain("【追高風險】");
  });
  it("週末：融資融券是週五 → 視為對得上", () => {
    const sat = new Date("2026-10-10T04:00:00Z"); // 週六
    expect(marginDataMatchesPrice("2026-10-09", sat)).toBe(true);
    expect(marginDataMatchesPrice(undefined, sat)).toBe(false);
  });
  it("changePercentOnDate：找不到那天或第一根 → null", () => {
    expect(changePercentOnDate([], "2026-10-05")).toBeNull();
    expect(changePercentOnDate([{ time: "2026-10-05", open: 1, high: 1, low: 1, close: 1, volume: 1 }], "2026-10-05")).toBeNull();
  });
});

describe("ensureMarginSignalMentioned（回答沒講出訊號就補程式說明）", () => {
  const line = `${MARGIN_SIGNAL_TITLE}（程式依單日數字算好，10/05單日數字，不是趨勢）：【籌碼沉澱】股價下跌、融資大減。依據：股價-5.6%、融資-4.9%（-9,367張）`;
  const grounding = `股票：聯電（2303，台股）\n目前價格：147.5\n${line}\n籌碼比例（…）`;
  it("提到該檔卻沒講出訊號名稱 → 補一句", () => {
    const r = ensureMarginSignalMentioned("聯電(2303)建議先不要買，技術面偏弱。", grounding);
    expect(r.appended).toEqual(["2303"]);
    expect(r.text).toContain(MARGIN_SIGNAL_APPENDIX_TITLE);
    expect(r.text).toContain("聯電(2303)：【籌碼沉澱】");
    expect(r.text).toContain("融資-4.9%（-9,367張）");
  });
  it("已講出訊號名稱 → 不動", () => {
    const a = "聯電(2303)融資大減、籌碼沉澱。";
    expect(ensureMarginSignalMentioned(a, grounding)).toEqual({ text: a, appended: [] });
  });
  it("沒提到那一檔 → 不動；參考資料沒有區塊 → 不動", () => {
    const a = "台積電(2330)可以買。";
    expect(ensureMarginSignalMentioned(a, grounding).appended).toEqual([]);
    expect(ensureMarginSignalMentioned("聯電(2303)不買。", "股票：聯電（2303，台股）").appended).toEqual([]);
  });
  it("最多補 4 檔", () => {
    const g = ["2303", "2330", "2454", "2317", "2412"]
      .map((c) => `股票：X${c}（${c}，台股）\n${line}`)
      .join("\n");
    const a = ["2303", "2330", "2454", "2317", "2412"].map((c) => `X${c}(${c})`).join("、");
    expect(ensureMarginSignalMentioned(a, g).appended).toHaveLength(4);
  });
});
