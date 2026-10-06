import { describe, expect, it } from "vitest";
import { guardHeldAnswer, guardHoldingLabels, parseHeldAnchors } from "@/lib/ai/ratingConsistencyGuard";
import { HOLDING_SUMMARY_TITLE } from "@/lib/ai/holdingRating";

// 2026-10-06 09:29 使用者回報的實例：程式「建議減碼」，AI 寫「建議停損／全部賣出」「減碼或出場」、虧損寫「獲利已吐回」。
const G =
  "陽明(2609，台股)：現價 50\n" +
  `${HOLDING_SUMMARY_TITLE}持有中評等為減碼／出場（該賣）的：陽明(2609)「建議減碼」（目前虧損約 6.2%）、聯電(2303)「建議減碼（買進後曾獲利約 10%，現已跌回成本以下）」（目前虧損約 1.3%）；其餘持有中（不用賣）：聯發科(2454)「續抱」（目前獲利約 4.1%）、長榮(2603)「續抱觀察、不加碼」（目前獲利約 2%）。問「賣哪些」時一律照這份。\n`;

describe("parseHeldAnchors", () => {
  it("從彙整取出每檔持有建議、核心與賺賠", () => {
    const a = parseHeldAnchors(G);
    expect(a.map((x) => [x.symbol, x.name, x.core, x.cls, x.pnlPct])).toEqual([
      ["2609", "陽明", "建議減碼", "reduce", -6.2],
      ["2303", "聯電", "建議減碼", "reduce", -1.3],
      ["2454", "聯發科", "續抱", "keep", 4.1],
      ["2603", "長榮", "續抱觀察、不加碼", "keep", 2],
    ]);
  });
});

describe("guardHoldingLabels（持有建議逐字照程式）", () => {
  it("減碼被升級成「建議停損／全部賣出」→ 改回建議減碼", () => {
    const r = guardHoldingLabels("**陽明(2609)**\n建議停損／全部賣出。法人連賣、跌破月線。", G);
    expect(r.text).toBe("**陽明(2609)**\n建議減碼。法人連賣、跌破月線。");
  });

  it("混寫「建議減碼或出場」→ 程式的單一動作", () => {
    const r = guardHoldingLabels("聯電(2303)：建議減碼或出場，營收衰退。", G);
    expect(r.text).toBe("聯電(2303)：建議減碼，營收衰退。");
  });

  it("虧損中寫「獲利已吐回」→ 改成已跌回成本以下；獲利中的不動", () => {
    const r = guardHoldingLabels("陽明：建議減碼，獲利已吐回。\n聯發科：續抱，先前獲利回吐不多。", G);
    expect(r.text).toBe("陽明：建議減碼，已跌回成本以下。\n聯發科：續抱，先前獲利回吐不多。");
  });

  it("條件句（若跌破 X 停損出場）不改；外資賣出、拉回可加碼這類非建議字眼不改", () => {
    const a = "聯發科：建議續抱，外資賣出 3,000 張，若跌破 1,200 就停損出場，拉回可加碼。";
    expect(guardHoldingLabels(a, G).text).toBe(a);
  });

  it("續抱的股票被寫成建議減碼 → 改回續抱；不加碼的股票被寫建議加碼 → 改回", () => {
    const r = guardHoldingLabels("聯發科：建議減碼。\n長榮：建議加碼。", G);
    expect(r.text).toBe("聯發科：建議續抱。\n長榮：建議續抱觀察、不加碼。");
  });

  it("「不建議加碼」否定句不改", () => {
    const a = "長榮：續抱觀察，不建議加碼。";
    expect(guardHoldingLabels(a, G).text).toBe(a);
  });
});

describe("guardHeldAnswer（沒寫出持有建議就補一行程式結論）", () => {
  it("提到但沒寫結論的持有中股票補在最後；沒提到的不補", () => {
    const r = guardHeldAnswer("陽明：建議減碼。\n聯發科：技術面轉強、法人買超。", G);
    expect(r.appended).toEqual(["2454"]);
    expect(r.text).toMatch(/本站持有建議（程式依評等與你的成本算好）：聯發科\(2454\)「續抱」$/);
  });
  it("沒有持有中股票的參考資料原樣回傳", () => {
    expect(guardHeldAnswer("建議停損／全部賣出", "無").text).toBe("建議停損／全部賣出");
  });
});
