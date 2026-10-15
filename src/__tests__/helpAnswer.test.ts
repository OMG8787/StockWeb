import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ system: string; messages: Array<{ role: string; content: string }> }> = [];
let mode: "ok" | "fail" | "throw" = "ok";
vi.mock("@/lib/ai/provider", () => ({
  callAiProviders: async (system: string, messages: Array<{ role: string; content: string }>) => {
    calls.push({ system, messages });
    if (mode === "throw") throw new Error("boom");
    return mode === "ok" ? { answer: "1. 按 ▶ 立即更新一次", usedAi: true, model: "gemini-test" } : { answer: "", usedAi: false, failureReason: "額度" };
  },
}));

const { answerHelpQuestion, NO_MATCH_ANSWER, sectionsForPrompt, HELP_SYSTEM_PROMPT } = await import("@/lib/help/helpAnswer");
const { MANUAL_BY_ID } = await import("@/lib/help/manual");

describe("教學助手回答", () => {
  beforeEach(() => {
    calls.length = 0;
    mode = "ok";
  });

  it("手冊找不到相關章節：直接回說明，不呼叫 AI", async () => {
    const r = await answerHelpQuestion("今天晚餐吃什麼");
    expect(r.answer).toBe(NO_MATCH_ANSWER);
    expect(r.usedAi).toBe(false);
    expect(r.sections).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("找到章節：把章節內容交給 AI，回傳 AI 的回答與相關章節", async () => {
    const r = await answerHelpQuestion("怎麼設定智能清單？");
    expect(r.usedAi).toBe(true);
    expect(r.answer).toContain("立即更新一次");
    expect(r.model?.id).toBe("gemini-test");
    expect(r.sections[0].id).toBe("smart-list");
    const last = calls[0].messages.at(-1)!;
    expect(last.content).toContain("使用者問題：怎麼設定智能清單？");
    expect(last.content).toContain("【章節 1：我的智能清單");
    expect(calls[0].system).toBe(HELP_SYSTEM_PROMPT);
    expect(HELP_SYSTEM_PROMPT).toContain("不要編");
  });

  it("AI 失敗或丟錯：用章節內容當程式版回答（仍然有答案）", async () => {
    for (const m of ["fail", "throw"] as const) {
      mode = m;
      const r = await answerHelpQuestion("怎麼回測一年");
      expect(r.usedAi).toBe(false);
      expect(r.answer).toContain("策略回測");
      expect(r.answer).toContain("操作");
      expect(r.sections.length).toBeGreaterThan(0);
    }
  });

  it("章節轉參考資料：過長截斷、附相關頁面", () => {
    const s = { ...MANUAL_BY_ID.get("backtest")!, body: "字".repeat(5000) };
    const text = sectionsForPrompt([s]);
    expect(text.length).toBeLessThan(2200);
    expect(text).toContain("/strategies/backtest");
  });
});
