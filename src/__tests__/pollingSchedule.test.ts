import { describe, expect, it } from "vitest";
import {
  classifyTwQuoteTradeDate,
  getPollDecision,
  isEmergingQuoteWindow,
  isTwQuoteWindow,
  mergePollDecisions,
  taipeiDayKey,
} from "@/lib/pollingSchedule";

/** 以台北時間（UTC+8）建立固定時鐘；2026-10-05 是週一、10-03 週六、10-04 週日。 */
function taipei(date: string, hhmm: string, ss = "00"): Date {
  return new Date(`${date}T${hhmm}:${ss}+08:00`);
}

describe("isTwQuoteWindow（平日 08:30~14:30）", () => {
  it("邊界：08:29 不在、08:30 在、14:29 在、14:30 不在", () => {
    expect(isTwQuoteWindow(taipei("2026-10-05", "08:29"))).toBe(false);
    expect(isTwQuoteWindow(taipei("2026-10-05", "08:30"))).toBe(true);
    expect(isTwQuoteWindow(taipei("2026-10-05", "14:29"))).toBe(true);
    expect(isTwQuoteWindow(taipei("2026-10-05", "14:30"))).toBe(false);
  });

  it("週末整天都不在", () => {
    expect(isTwQuoteWindow(taipei("2026-10-03", "10:00"))).toBe(false);
    expect(isTwQuoteWindow(taipei("2026-10-04", "10:00"))).toBe(false);
  });

  it("用台北時間而非 UTC：UTC 週日 17:00 已是台北週一 01:00", () => {
    expect(taipeiDayKey(new Date("2026-10-04T17:00:00Z"))).toBe("2026-10-05");
    expect(isTwQuoteWindow(new Date("2026-10-05T01:00:00Z"))).toBe(true); // 台北週一 09:00
  });
});

describe("isEmergingQuoteWindow（平日 09:00~15:10）", () => {
  it("邊界", () => {
    expect(isEmergingQuoteWindow(taipei("2026-10-05", "08:59"))).toBe(false);
    expect(isEmergingQuoteWindow(taipei("2026-10-05", "09:00"))).toBe(true);
    expect(isEmergingQuoteWindow(taipei("2026-10-05", "15:09"))).toBe(true);
    expect(isEmergingQuoteWindow(taipei("2026-10-05", "15:10"))).toBe(false);
    expect(isEmergingQuoteWindow(taipei("2026-10-04", "10:00"))).toBe(false);
  });
});

describe("getPollDecision", () => {
  it("台股盤中：每 30 秒抓一次", () => {
    expect(getPollDecision("TW", taipei("2026-10-05", "10:00"))).toEqual({ fetch: true, settle: false, nextCheckMs: 30_000 });
  });

  it("14:40 之後當天還沒補抓 → 補抓一次；補抓過就不再抓", () => {
    const now = taipei("2026-10-05", "14:41");
    expect(getPollDecision("TW", now, null)).toMatchObject({ fetch: true, settle: true });
    expect(getPollDecision("TW", now, "2026-10-05")).toMatchObject({ fetch: false, settle: false });
  });

  it("14:30~14:40 之間不抓，下一次檢查排到 14:40（精準到秒、上限 60 秒）", () => {
    const far = getPollDecision("TW", taipei("2026-10-05", "14:35", "30"));
    expect(far.fetch).toBe(false);
    expect(far.nextCheckMs).toBe(60_000); // 距離 14:40 還有 4 分 30 秒，夾在 IDLE_CHECK_MS
    const near = getPollDecision("TW", taipei("2026-10-05", "14:39", "40"));
    expect(near.nextCheckMs).toBe(20_000);
  });

  it("週末不抓、不補抓", () => {
    expect(getPollDecision("TW", taipei("2026-10-04", "15:00"), null)).toMatchObject({ fetch: false, settle: false });
  });

  it("興櫃 09:00~15:10 抓，永遠 settle:false", () => {
    expect(getPollDecision("TW-EMERGING", taipei("2026-10-05", "14:00"))).toEqual({ fetch: true, settle: false, nextCheckMs: 30_000 });
    expect(getPollDecision("TW-EMERGING", taipei("2026-10-05", "15:20"))).toMatchObject({ fetch: false, settle: false });
  });

  it("mergePollDecisions：任一要抓就抓、間隔取最短、套用下限", () => {
    const merged = mergePollDecisions([
      { fetch: false, settle: false, nextCheckMs: 60_000 },
      { fetch: true, settle: true, nextCheckMs: 30_000 },
    ]);
    expect(merged).toEqual({ fetch: true, settle: true, nextCheckMs: 30_000 });
    expect(mergePollDecisions([{ fetch: true, settle: false, nextCheckMs: 30_000 }], 45_000).nextCheckMs).toBe(45_000);
    expect(mergePollDecisions([])).toEqual({ fetch: false, settle: false, nextCheckMs: 60_000 });
  });
});

describe("classifyTwQuoteTradeDate", () => {
  it("輪詢窗內一律 live（不看日期）", () => {
    expect(classifyTwQuoteTradeDate(undefined, "TW", taipei("2026-10-05", "10:00"))).toBe("live");
  });

  it("收盤後：今天的日期 → settled-today；更早的平日 → earlier-session", () => {
    const now = taipei("2026-10-05", "16:00");
    expect(classifyTwQuoteTradeDate("2026-10-05", "TW", now)).toBe("settled-today");
    expect(classifyTwQuoteTradeDate("2026-10-02", "TW", now)).toBe("earlier-session");
  });

  it("開盤前拿到今天的日期 → pre-open（重置後初始狀態）", () => {
    expect(classifyTwQuoteTradeDate("2026-10-05", "TW", taipei("2026-10-05", "07:00"))).toBe("pre-open");
  });

  it("沒有日期、未來日期、週末日期 → invalid-date", () => {
    const now = taipei("2026-10-04", "12:00"); // 週日
    expect(classifyTwQuoteTradeDate(undefined, "TW", now)).toBe("invalid-date");
    expect(classifyTwQuoteTradeDate("2026-10-05", "TW", now)).toBe("invalid-date"); // 未來
    expect(classifyTwQuoteTradeDate("2026-10-03", "TW", now)).toBe("invalid-date"); // 週六
    expect(classifyTwQuoteTradeDate("2026-10-02", "TW", now)).toBe("earlier-session");
  });

  it("興櫃收盤時間是 15:00（上市櫃是 13:30）", () => {
    expect(classifyTwQuoteTradeDate("2026-10-05", "TW-EMERGING", taipei("2026-10-05", "15:15"))).toBe("settled-today");
    expect(classifyTwQuoteTradeDate("2026-10-05", "TW", taipei("2026-10-05", "14:35"))).toBe("settled-today");
  });
});
