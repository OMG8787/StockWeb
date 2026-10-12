import { describe, expect, it } from "vitest";
import { AI_PICK_LIMIT_DEFAULT, AI_PICK_LIMIT_OPTIONS, normalizePickLimit } from "@/lib/aiPickLimits";
import { AI_LIST_MAX } from "@/lib/ai/actionPicks";

describe("AI 建議名單檔數設定", () => {
  it("只接受選項內的值，其餘回預設", () => {
    for (const n of AI_PICK_LIMIT_OPTIONS) expect(normalizePickLimit(n)).toBe(n);
    expect(normalizePickLimit("10")).toBe(10);
    expect(normalizePickLimit(7)).toBe(AI_PICK_LIMIT_DEFAULT);
    expect(normalizePickLimit(undefined)).toBe(AI_PICK_LIMIT_DEFAULT);
    expect(normalizePickLimit(999)).toBe(AI_PICK_LIMIT_DEFAULT);
  });
  it("最大選項不超過共用排名名單上限", () => {
    expect(Math.max(...AI_PICK_LIMIT_OPTIONS)).toBeLessThanOrEqual(AI_LIST_MAX);
  });
});
