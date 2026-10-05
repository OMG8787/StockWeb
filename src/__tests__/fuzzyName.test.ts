import { describe, expect, it } from "vitest";
import { describeFuzzyGuess, extractSubject, guessByFuzzyName } from "@/lib/ai/fuzzyName";

const LIST = [
  { symbol: "2330", name: "台積電" },
  { symbol: "2317", name: "鴻海" },
  { symbol: "2383", name: "台光電" },
  { symbol: "3044", name: "健鼎" },
  { symbol: "2327", name: "國巨*" },
  { symbol: "2454", name: "聯發科" },
  { symbol: "2332", name: "友訊" },
  { symbol: "2419", name: "仲琦" },
  { symbol: "2332X", name: "明泰" },
  { symbol: "1301", name: "台塑" },
];

describe("名稱近似比對（錯字先猜最可能的那檔）", () => {
  it("建鼎→健鼎、台機電→台積電、鴻每→鴻海", () => {
    expect(guessByFuzzyName("建鼎呢?", LIST)?.best.symbol).toBe("3044");
    expect(guessByFuzzyName("台機電現在能買嗎", LIST)?.best.symbol).toBe("2330");
    expect(guessByFuzzyName("那鴻每今天怎麼樣", LIST)?.best.symbol).toBe("2317");
  });

  it("少一個字也接得住（台積→台積電）；國巨* 的標記不影響", () => {
    expect(guessByFuzzyName("台積呢", LIST)?.best.symbol).toBe("2330");
    expect(guessByFuzzyName("國距呢", LIST)).toBeNull(); // 距↔巨 不在同音表、又只有 2 字
  });

  it("不相干詞不觸發：明天、台股、大盤、一般問句", () => {
    for (const q of ["明天有建議買入甚麼股票嗎?", "台股今天怎麼樣", "大盤呢", "那有MACD與KD線都黃金交叉的嗎?", "今天天氣如何", "有建議現價可買的嗎?"]) {
      expect(guessByFuzzyName(q, LIST), q).toBeNull();
    }
  });

  it("主詞擷取", () => {
    expect(extractSubject("請問建鼎現在能買嗎")).toBe("建鼎");
    expect(extractSubject("建鼎")).toBe("建鼎");
    expect(extractSubject("2330呢")).toBeNull();
  });

  it("內部標記要求開頭先確認", () => {
    const g = guessByFuzzyName("建鼎呢?", LIST)!;
    expect(describeFuzzyGuess(g)).toContain("你是指健鼎(3044)嗎？以下以健鼎回答");
  });
});
