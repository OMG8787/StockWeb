import { describe, expect, it } from "vitest";
import { detectMarket } from "@/lib/data/symbols";
import { TW_ETF_CODE } from "@/lib/data/twse";

describe("ETF 代號（2026-10-15：搜尋 00406A 抓不到）", () => {
  it("數字＋一個英文字母的代號判斷為台股，純英文為美股", () => {
    for (const s of ["00406A", "00631L", "00632R", "00679B", "00635U", "2881A", "0050", "2330"]) expect(detectMarket(s), s).toBe("TW");
    for (const s of ["AAPL", "TSLA", "NVDA"]) expect(detectMarket(s), s).toBe("US");
  });
  it("ETF 代號格式：00 開頭 4～6 碼數字、可接一個字母；一般股票與特別股不算", () => {
    for (const s of ["0050", "0056", "00878", "00406A", "00679B", "006201"]) expect(TW_ETF_CODE.test(s), s).toBe(true);
    for (const s of ["2330", "2881A", "020000", "01001T", "1101"]) expect(TW_ETF_CODE.test(s), s).toBe(false);
  });
});
