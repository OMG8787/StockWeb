import { describe, expect, it } from "vitest";
import { getTradingStance } from "@/lib/ai/tradingStance";
import { getTwTradingPhase } from "@/lib/pollingSchedule";

// 台北時間 = UTC+8。2026-10-05 是週一、10-09 週五、10-10 週六。
const tpe = (iso: string) => new Date(`${iso}+08:00`);

describe("getTwTradingPhase／getTradingStance（假時鐘）", () => {
  it("08:45 開盤前 → 今日建議、今天開盤立場", () => {
    const s = getTradingStance(tpe("2026-10-05T08:45:00"));
    expect(getTwTradingPhase(tpe("2026-10-05T08:45:00"))).toBe("pre-open");
    expect(s.briefMode).toBe("today");
    expect(s.briefTitle).toBe("今日建議");
    expect(s.stanceLine).toContain("今天開盤");
  });

  it("10:00 盤中 → 今日建議、盤中立場", () => {
    const s = getTradingStance(tpe("2026-10-05T10:00:00"));
    expect(s.phase).toBe("intraday");
    expect(s.briefTitle).toBe("今日建議");
    expect(s.stanceLine).toContain("盤中");
  });

  it("13:30 與 14:29 → 盤後定價立場（以收盤價成交），標題仍是今日建議", () => {
    for (const t of ["2026-10-05T13:30:00", "2026-10-05T14:29:00"]) {
      const s = getTradingStance(tpe(t));
      expect(s.phase).toBe("after-hours-fixed");
      expect(s.briefTitle).toBe("今日建議");
      expect(s.stanceLine).toContain("盤後定價");
      expect(s.stanceLine).toContain("收盤價成交");
    }
  });

  it("13:29 仍是盤中", () => {
    expect(getTwTradingPhase(tpe("2026-10-05T13:29:00"))).toBe("intraday");
  });

  it("週一 14:30 → 明日開盤建議，立場是明天 10/6（週二）開盤", () => {
    const s = getTradingStance(tpe("2026-10-05T14:30:00"));
    expect(s.phase).toBe("after-close");
    expect(s.briefMode).toBe("next-open");
    expect(s.briefTitle).toBe("明日開盤建議");
    expect(s.nextOpenLabel).toBe("10/6（週二）");
    expect(s.stanceLine).toContain("明天開盤要不要買");
  });

  it("週五 15:00 → 下個交易日開盤建議（10/12 週一）", () => {
    const s = getTradingStance(tpe("2026-10-09T15:00:00"));
    expect(s.briefTitle).toBe("下個交易日開盤建議");
    expect(s.nextOpenLabel).toBe("10/12（週一）");
  });

  it("週六 → 週末、下個交易日開盤建議", () => {
    const s = getTradingStance(tpe("2026-10-10T11:00:00"));
    expect(s.phase).toBe("weekend");
    expect(s.briefMode).toBe("next-open");
    expect(s.briefTitle).toBe("下個交易日開盤建議");
    expect(s.nextOpenLabel).toBe("10/12（週一）");
  });

  it("週二凌晨 01:00 → 開盤前、今日建議（快取 key 依模式區分，不沿用前一晚的明日開盤版）", () => {
    const s = getTradingStance(tpe("2026-10-06T01:00:00"));
    expect(s.phase).toBe("pre-open");
    expect(s.briefMode).toBe("today");
  });
});
