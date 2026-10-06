import { describe, expect, it } from "vitest";
import { GEMINI_THINKING_ALLOWANCE, geminiGenerationConfig, isGeminiThinkingModel, premiumAllowedHere, rankGeminiModels } from "@/lib/ai/gemini";

// 2026-10-05 這把金鑰的實際 ListModels（節錄）
const LISTED =
  "gemini-2.5-flash, gemini-2.5-pro, gemini-2.5-flash-preview-tts, gemma-4-31b-it, gemini-flash-latest, gemini-flash-lite-latest, gemini-pro-latest, gemini-2.5-flash-lite, gemini-2.5-flash-image, gemini-3-flash-preview, gemini-3.1-flash-lite, gemini-3.5-flash, gemini-3.5-flash-lite, gemini-omni-flash-preview, gemini-3.8-flash, gemini-3.8-flash-tts".split(
    ", "
  );

describe("rankGeminiModels（Gemini 模型分級）", () => {
  it("standard（AI 問答）：lite 主力在前，flash-lite-latest 第一", () => {
    const r = rankGeminiModels(LISTED, "standard");
    expect(r.slice(0, 4)).toEqual(["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"]);
    expect(r.slice(4).every((m) => !/lite/.test(m))).toBe(true);
  });

  it("premium（今日快報／建議／AI 判斷層）：非 lite 思考模型在前，lite 最後備援", () => {
    const r = rankGeminiModels(LISTED, "premium");
    expect(r.slice(0, 4)).toEqual(["gemini-flash-latest", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash"]);
    expect(r.at(-1)).toMatch(/lite/);
  });

  it("排除語音、圖片、向量、omni、pro、gemma 等", () => {
    const r = rankGeminiModels(LISTED, "premium");
    expect(r.some((m) => /tts|image|omni|pro|gemma/.test(m))).toBe(false);
  });

  it("思考模型的 generationConfig 加 thinkingConfig 與思考預算；lite 不加", () => {
    expect(isGeminiThinkingModel("gemini-3.5-flash")).toBe(true);
    expect(isGeminiThinkingModel("gemini-flash-lite-latest")).toBe(false);
    expect(geminiGenerationConfig("gemini-3.5-flash", 1600)).toMatchObject({
      maxOutputTokens: 1600 + GEMINI_THINKING_ALLOWANCE,
      thinkingConfig: { thinkingLevel: "low" },
    });
    expect(geminiGenerationConfig("gemini-2.5-flash", 1000)).toMatchObject({ thinkingConfig: { thinkingBudget: 1024 } });
    const lite = geminiGenerationConfig("gemini-flash-lite-latest", 1000);
    expect(lite.maxOutputTokens).toBe(1000);
    expect(lite).not.toHaveProperty("thinkingConfig");
  });
});

describe("premiumAllowedHere", () => {
  it("只有正式站或明確開啟才用非 lite（本機測試不吃正式站配額）", () => {
    expect(premiumAllowedHere({ VERCEL: "1" })).toBe(true);
    expect(premiumAllowedHere({})).toBe(false);
    expect(premiumAllowedHere({ GEMINI_PREMIUM_LOCAL: "true" })).toBe(true);
  });
});
