import { describe, expect, it, vi } from "vitest";
import { displayModelName, modelInfo } from "@/lib/ai/modelName";
import { aggregateModelStats } from "@/lib/ai/modelStats";

vi.mock("@/lib/ai/providerAdapters", () => {
  const fake = (id: string, model: string, fail = false) => ({
    id,
    label: id,
    isConfigured: () => true,
    canHandle: () => true,
    preferredTimeoutMs: (t: number) => t,
    call: async () => {
      if (fail) throw new Error("HTTP 429");
      return { text: "回答內容", model };
    },
  });
  return {
    ADAPTERS: {
      gemini: fake("gemini", "gemini-2.5-flash", true),
      nvidia: fake("nvidia", "nvidia/nemotron-3-super-120b-a12b"),
      groq: fake("groq", "openai/gpt-oss-120b"),
      anthropic: { ...fake("anthropic", "claude-sonnet-5"), isConfigured: () => false },
    },
  };
});

describe("displayModelName", () => {
  it("常見模型轉好讀名稱、未知原樣", () => {
    expect(displayModelName("gemini-2.5-flash")).toBe("Gemini 2.5 Flash");
    expect(displayModelName("models/gemini-2.5-flash-lite")).toBe("Gemini 2.5 Flash Lite");
    expect(displayModelName("nvidia/nemotron-3-super-120b-a12b")).toBe("NVIDIA Nemotron 3 Super");
    expect(displayModelName("openai/gpt-oss-120b")).toBe("Groq GPT-OSS 120B");
    expect(displayModelName("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(displayModelName("some-model")).toBe("some-model");
    expect(modelInfo(undefined)).toBeUndefined();
  });
});

describe("callAiProviders 回傳實際模型", () => {
  it("Gemini 失敗改由 NVIDIA 回答時 model 是 NVIDIA 的模型", async () => {
    const { callAiProviders } = await import("@/lib/ai/provider");
    const r = await callAiProviders("系統", [{ role: "user", content: "問" }]);
    expect(r.usedAi).toBe(true);
    expect(r.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(modelInfo(r.model)).toEqual({ id: "nvidia/nemotron-3-super-120b-a12b", name: "NVIDIA Nemotron 3 Super" });
  });
});

describe("aggregateModelStats", () => {
  it("多天加總、備援文字算回答數", () => {
    const rows = aggregateModelStats([
      { "gemini-2.5-flash|answer": 3, "gemini-2.5-flash|up": 1, "none|fallback": 2 },
      null,
      { "gemini-2.5-flash|answer": "2", "gemini-2.5-flash|down": 1 },
    ]);
    expect(rows[0]).toEqual({ model: "gemini-2.5-flash", answer: 5, up: 1, down: 1, report: 0 });
    expect(rows[1]).toEqual({ model: "none", answer: 2, up: 0, down: 0, report: 0 });
  });
});
