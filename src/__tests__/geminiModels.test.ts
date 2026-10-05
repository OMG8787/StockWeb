import { describe, expect, it } from "vitest";
import { rankGeminiModels } from "@/lib/ai/gemini";

describe("rankGeminiModels（Gemini 模型偏好順序）", () => {
  it("lite 排在 ListModels 前面時，仍優先 2.5-flash、flash-latest，lite 最後", () => {
    const listed = [
      "gemini-flash-lite-latest",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
      "gemini-flash-latest",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
    ];
    expect(rankGeminiModels(listed)).toEqual([
      "gemini-2.5-flash",
      "gemini-flash-latest",
      "gemini-2.0-flash",
      "gemini-flash-lite-latest",
      "gemini-2.5-flash-lite",
      "gemini-2.5-pro",
    ]);
  });

  it("排除語音、圖片、向量、即時串流等非文字生成模型", () => {
    const listed = [
      "gemini-2.5-flash-preview-tts",
      "gemini-2.5-flash-image",
      "gemini-embedding-001",
      "gemini-2.5-flash-native-audio-latest",
      "gemini-live-2.5-flash-preview",
      "gemini-2.5-flash",
    ];
    expect(rankGeminiModels(listed)).toEqual(["gemini-2.5-flash"]);
  });

  it("偏好模型都不在清單時，非 lite 的 flash 先於 lite", () => {
    expect(rankGeminiModels(["gemini-2.0-flash-lite", "gemini-3-flash-preview"])).toEqual([
      "gemini-3-flash-preview",
      "gemini-2.0-flash-lite",
    ]);
  });

  it("2026-10-05 實際 ListModels 清單：前 4 個候選不含 lite／tts／image／omni", () => {
    const listed = "gemini-2.5-flash, gemini-2.5-pro, gemini-2.5-flash-preview-tts, gemma-4-31b-it, gemini-flash-latest, gemini-flash-lite-latest, gemini-pro-latest, gemini-2.5-flash-lite, gemini-2.5-flash-image, gemini-3-flash-preview, gemini-3.1-flash-lite, gemini-3.5-flash, gemini-3.5-flash-lite, gemini-omni-flash-preview, gemini-3.8-flash".split(", ");
    expect(rankGeminiModels(listed).slice(0, 4)).toEqual(["gemini-2.5-flash", "gemini-flash-latest", "gemini-3-flash-preview", "gemini-3.5-flash"]);
  });
});
