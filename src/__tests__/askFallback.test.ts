import { describe, expect, it } from "vitest";
import { sanitizeLeakedMarkers } from "@/lib/ai/askFallback";

describe("sanitizeLeakedMarkers", () => {
  it("把模型輸出的字面「\n」還原成真正換行", () => {
    expect(sanitizeLeakedMarkers("建議續抱\n- 損益 +2.0%")).toBe("建議續抱\n- 損益 +2.0%");
  });
  it("正常換行不受影響", () => {
    expect(sanitizeLeakedMarkers("建議買進\n- 理由")).toBe("建議買進\n- 理由");
  });
});
