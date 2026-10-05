import { describe, expect, it } from "vitest";
import { guardAvoidPriceAdvice } from "@/lib/ai/ratingConsistencyGuard";

const G_AVOID =
  "【本站綜合評等】聯電(2303)：未持有：「建議先不要買」／已持有：「續抱觀察、不加碼」。理由：x。改判建議買進的條件：技術面轉為支持。\n" +
  "【價位參考】下方支撐 134.5（MA60）\n";
const G_TWO =
  G_AVOID + "【本站綜合評等】台積電(2330)：未持有：「建議買進」／已持有：「可分批加碼」。理由：y。價位：買進後跌破 1,390 出場。\n";

describe("guardAvoidPriceAdvice（先不要買不可出現出場價／買進區間）", () => {
  it("刪掉「若買進後跌破 134.5 元建議出場」子句（正式站實例）", () => {
    const r = guardAvoidPriceAdvice("建議先不要買。技術面轉弱，等站回月線再說，若買進後跌破 134.5 元建議出場。", G_AVOID);
    expect(r.text).toBe("建議先不要買。技術面轉弱，等站回月線再說。");
    expect(r.fixes).toHaveLength(1);
  });

  it("刪掉「等回到 A～B 再分批買」與停損價", () => {
    const r = guardAvoidPriceAdvice("聯電建議先不要買\n- 可等回到 134.5～140 再分批買進\n- 停損價 130", G_AVOID);
    expect(r.text).toBe("聯電建議先不要買");
  });

  it("建議買進的股票出場價保留；多檔時依最近提到的股票判斷", () => {
    const a = "聯電：建議先不要買，買進後跌破 134.5 出場。\n台積電：建議買進，買進後跌破 1,390 出場。";
    const r = guardAvoidPriceAdvice(a, G_TWO);
    expect(r.text).toBe("聯電：建議先不要買。\n台積電：建議買進，買進後跌破 1,390 出場。");
  });

  it("使用者持有（有持有中出場參考）時不刪", () => {
    const g = G_AVOID + "【持有中出場參考】跌破 134.5 停損\n";
    const a = "續抱觀察，跌破 134.5 停損。";
    expect(guardAvoidPriceAdvice(a, g).text).toBe(a);
  });

  it("沒有先不要買的檔 → 原樣", () => {
    const g = "【本站綜合評等】台積電(2330)：未持有：「建議買進」／已持有：「可分批加碼」。";
    expect(guardAvoidPriceAdvice("買進後跌破 1,390 出場。", g).text).toBe("買進後跌破 1,390 出場。");
  });
});
