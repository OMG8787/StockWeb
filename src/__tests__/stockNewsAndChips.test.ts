import { describe, expect, it } from "vitest";
import { chipsSectionTitle, formatStockNewsLines, isMultiStockRoundupTitle } from "@/lib/ai/grounding/stockNewsAndChips";

describe("isMultiStockRoundupTitle", () => {
  it("括號帶出其他代號的彙整標題要濾掉", () => {
    expect(
      isMultiStockRoundupTitle("三大法人買賣超 – 外資買超(2327)國巨*、(2330)台積電，投信買超(8046)南電、(3189)景碩，法人合計買超292.53億元", "2330")
    ).toBe(true);
  });
  it("只提到本檔（或沒有代號）的標題保留", () => {
    expect(isMultiStockRoundupTitle("台積電(2330)ADR走強，台股創高後量能跟得上嗎？", "2330")).toBe(false);
    expect(isMultiStockRoundupTitle("台股49K來了！台積電飆75元至2575同創高", "2330")).toBe(false);
    expect(isMultiStockRoundupTitle("Apple (AAPL) beats estimates", "AAPL")).toBe(false);
  });
});

describe("formatStockNewsLines", () => {
  it("加台北日期、濾掉彙整標題", () => {
    const lines = formatStockNewsLines(
      [
        { title: "台積電創新高", source: "ETtoday", pubDate: "Sun, 04 Oct 2026 17:30:00 GMT" },
        { title: "外資買超(2327)國巨、(2330)台積電", pubDate: "Mon, 05 Oct 2026 01:00:00 GMT" },
      ],
      "2330"
    );
    expect(lines).toEqual(["- [10/05] 台積電創新高（ETtoday）"]);
  });
});

describe("chipsSectionTitle", () => {
  it("資料日是今天", () => {
    expect(chipsSectionTitle("2026-10-05", "2026-10-05")).toBe("籌碼面（10/05，今天的資料）");
  });
  it("盤中：資料日是上一個交易日，明講今天的要收盤後才公布", () => {
    const t = chipsSectionTitle("2026-10-02", "2026-10-05");
    expect(t).toContain("10/02的資料");
    expect(t).toContain("今天10/05的個股三大法人買賣超要收盤後");
  });
  it("週末", () => {
    expect(chipsSectionTitle("2026-10-02", "2026-10-04", true)).toBe("籌碼面（10/02的資料，最近一個交易日；今天非交易日）");
  });
  it("沒有日期", () => {
    expect(chipsSectionTitle(undefined, "2026-10-05")).toBe("籌碼面（最近一個交易日）");
  });
});
