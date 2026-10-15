import { describe, expect, it } from "vitest";
import { momentumTone } from "@/lib/momentumTone";

const s = (label: string, tone: "up" | "down" | "neutral") => ({ label, tone });

describe("共振方向（跟本站評等技術面同一套）", () => {
  it("多方 ≥2 且沒有空方＝bull；漲多警訊不算多方；空方多＝bear", () => {
    expect(momentumTone([s("站上20日均線", "up"), s("均線多頭排列", "up"), s("RSI 83（超買區）", "up")])).toBe("bull");
    expect(momentumTone([s("站上20日均線", "up"), s("RSI 83（超買區）", "up"), s("觸及布林通道上緣", "up")])).toBe("mixed");
    expect(momentumTone([s("站上20日均線", "up"), s("均線多頭排列", "up"), s("KD高檔死亡交叉", "down")])).toBe("mixed");
    expect(momentumTone([s("跌破20日均線", "down"), s("連跌 3 天", "down"), s("爆量", "neutral")])).toBe("bear");
  });
});
