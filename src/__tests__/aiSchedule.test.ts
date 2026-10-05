import { describe, expect, it } from "vitest";
import { ACTION_BRIEF_SLOTS_TRADING, actionBriefSlot, dailyBriefSlot, writtenAtLabel } from "@/lib/ai/aiSchedule";
import { GEMINI_PURPOSE_CAP, premiumCallAllowed, premiumFellBack } from "@/lib/ai/gemini";

// 台北時間 = UTC+8；2026-10-05 是週一、10-10 是週六
const tpe = (iso: string) => new Date(`${iso}+08:00`);

describe("較強模型重寫時點（假時鐘）", () => {
  it("今日建議交易日時點：08:30、09:00～13:30 每 30 分、13:35、14:35、21:35（共 14 個）", () => {
    expect(ACTION_BRIEF_SLOTS_TRADING).toEqual([
      "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "13:35", "14:35", "21:35",
    ]);
  });

  it("盤中落在最近一個時點；兩個時點之間沿用同一個 key", () => {
    expect(actionBriefSlot(tpe("2026-10-05T10:14:00")).key).toBe("2026-10-05T10:00");
    expect(actionBriefSlot(tpe("2026-10-05T10:29:59")).key).toBe("2026-10-05T10:00");
    expect(actionBriefSlot(tpe("2026-10-05T10:30:00")).key).toBe("2026-10-05T10:30");
    expect(actionBriefSlot(tpe("2026-10-05T14:40:00")).key).toBe("2026-10-05T14:35");
    expect(actionBriefSlot(tpe("2026-10-05T23:59:00")).key).toBe("2026-10-05T21:35");
  });

  it("清晨第一個時點之前沿用前一天最後一個時點；週一清晨往回到週日", () => {
    expect(actionBriefSlot(tpe("2026-10-06T07:00:00")).key).toBe("2026-10-05T21:35");
    expect(actionBriefSlot(tpe("2026-10-05T07:00:00")).key).toBe("2026-10-04T21:35");
  });

  it("週末只在 08:30 與 21:35 重寫", () => {
    expect(actionBriefSlot(tpe("2026-10-10T12:00:00")).key).toBe("2026-10-10T08:30");
    expect(actionBriefSlot(tpe("2026-10-10T22:00:00")).key).toBe("2026-10-10T21:35");
  });

  it("快報：08:20、10:30、12:30、13:40、21:40、23:30", () => {
    expect(dailyBriefSlot(tpe("2026-10-05T13:39:00")).key).toBe("2026-10-05T12:30");
    expect(dailyBriefSlot(tpe("2026-10-05T13:40:00")).key).toBe("2026-10-05T13:40");
    expect(dailyBriefSlot(tpe("2026-10-05T23:45:00")).key).toBe("2026-10-05T23:30");
    expect(dailyBriefSlot(tpe("2026-10-06T08:00:00")).key).toBe("2026-10-05T23:30");
  });
});

describe("配額優先順序：今日建議＞快報＞AI 判斷", () => {
  it("同一模型已用次數越多，低優先用途越早被擋", () => {
    expect(GEMINI_PURPOSE_CAP.action).toBeGreaterThan(GEMINI_PURPOSE_CAP.brief);
    expect(GEMINI_PURPOSE_CAP.brief).toBeGreaterThan(GEMINI_PURPOSE_CAP.judge);
    expect(premiumCallAllowed(8, "judge")).toBe(true);
    expect(premiumCallAllowed(9, "judge")).toBe(false);
    expect(premiumCallAllowed(9, "brief")).toBe(true);
    expect(premiumCallAllowed(15, "brief")).toBe(false);
    expect(premiumCallAllowed(18, "action")).toBe(true);
    expect(premiumCallAllowed(19, "action")).toBe(false);
  });

  it("退回 lite 的判斷與卡片標示", () => {
    expect(premiumFellBack("gemini-flash-lite-latest")).toBe(true);
    expect(premiumFellBack("nvidia/nemotron-3-super-120b-a12b")).toBe(true);
    expect(premiumFellBack("gemini-3.5-flash")).toBe(false);
    expect(writtenAtLabel("2026-10-05T02:30:00.000Z", "Gemini 3.5 Flash")).toBe("分析撰寫於 10:30（Gemini 3.5 Flash），數字即時更新");
    expect(writtenAtLabel("2026-10-05T02:30:00.000Z", "Gemini Flash Lite", true)).toContain("較強模型今日額度用完或暫時無法使用");
  });
});
