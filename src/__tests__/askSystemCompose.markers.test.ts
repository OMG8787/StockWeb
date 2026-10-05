import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BLOCK_MARKERS } from "@/lib/ai/askSystemCompose";

// askSystemCompose.ts 依「資料文字裡有沒有某個區塊標題」決定要不要帶對應規則。
// 產生該區塊的程式若改了標題字串，規則會悄悄消失、不會報錯——這個測試把兩邊綁在一起。
const SRC = join(__dirname, "..", "lib");
const producers: Array<[keyof typeof BLOCK_MARKERS, string]> = [
  ["chipsRatios", "ai/grounding/chipsRatios.ts"],
  ["socialSentiment", "ai/grounding/sentiment.ts"],
  ["institutional", "ai/grounding/stock.ts"],
  ["priceLevels", "ai/grounding/priceLevels.ts"],
  ["macro", "ai/macroText.ts"],
  ["nightFutures", "ai/marketOverview.ts"],
];

describe("askSystemCompose BLOCK_MARKERS 與資料區塊標題一致", () => {
  it.each(producers)("%s 的標記字串出現在 %s", (key, file) => {
    const marker = BLOCK_MARKERS[key];
    expect(typeof marker).toBe("string");
    expect(readFileSync(join(SRC, file), "utf-8")).toContain(marker as string);
  });

  it("相似案例與教訓標題由 learning/ 共用常數提供，且產生端確實使用", () => {
    expect(BLOCK_MARKERS.similarCases).toBe("【相似案例統計（本站評等紀錄）】");
    expect(BLOCK_MARKERS.lessons).toBe("【相關教訓（本站歷史檢討）】");
    expect(readFileSync(join(SRC, "ai/learning/similar.ts"), "utf-8")).toContain("${SIMILAR_CASES_TITLE}");
    expect(readFileSync(join(SRC, "ai/learning/lessonMatch.ts"), "utf-8")).toContain("${LESSONS_TITLE}");
    expect(readFileSync(join(SRC, "ai/grounding/stock.ts"), "utf-8")).toContain("describeExperience(");
  });

  it("近5日交叉紀錄標題由 indicators.ts 共用常數提供", () => {
    expect(BLOCK_MARKERS.recentCrosses).toBe("近5個交易日逐日的MACD／KD交叉紀錄");
    expect(readFileSync(join(SRC, "ai/grounding/stock.ts"), "utf-8")).toContain("RECENT_CROSSES_TITLE");
  });
});
