import { describe, expect, it } from "vitest";
import { ensureChipsDateMentioned } from "@/lib/ai/chipsDateMention";

const staleGrounding =
  "籌碼面（10/06的資料；今天10/07的個股三大法人買賣超要收盤後約15~16點、融資融券約21點後才公布，使用者問「今天」時要先講明這是10/06的數字）：三大法人合計賣超22張";
describe("ensureChipsDateMentioned", () => {
  it("使用者原案（達新）：講了三大法人賣超卻沒講日期 → 補註", () => {
    const a = "達新建議先不要買。籌碼面顯示三大法人合計賣超22張（外資賣超22張），不宜追高。";
    const r = ensureChipsDateMentioned(a, staleGrounding);
    expect(r.appended).toHaveLength(1);
    expect(r.text).toContain("10/06");
    expect(r.text).toContain("15:00");
    expect(r.text.indexOf("註：")).toBeGreaterThan(a.indexOf("賣超22張"));
    expect(r.text).toContain("不宜追高");
  });
  it("回答已講日期（10/06 或 前一交易日）→ 不補", () => {
    expect(ensureChipsDateMentioned("10/06 三大法人合計賣超351,842股。", staleGrounding).appended).toEqual([]);
    expect(ensureChipsDateMentioned("前一交易日三大法人買超300張。", staleGrounding).appended).toEqual([]);
  });
  it("今天的資料（標題沒有日期說明）→ 不補", () => {
    const todayGrounding = "籌碼面（10/07，今天的資料）：三大法人合計買超22張";
    expect(ensureChipsDateMentioned("三大法人合計買超22張。", todayGrounding).appended).toEqual([]);
  });
  it("回答沒提法人買賣超 → 不補", () => {
    expect(ensureChipsDateMentioned("技術面偏多，建議買進。", staleGrounding).appended).toEqual([]);
  });
  it("週末 → 註明今天非交易日", () => {
    const g = "籌碼面（10/09的資料，最近一個交易日；今天非交易日）：三大法人合計賣超3張";
    const r = ensureChipsDateMentioned("三大法人合計賣超3張。", g);
    expect(r.text).toContain("今天非交易日");
  });
});
