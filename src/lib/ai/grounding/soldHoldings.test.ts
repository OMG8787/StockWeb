import { describe, expect, it } from "vitest";
import { formatSoldLine, summarizeSoldLines, type SoldLineInput } from "./soldHoldings";
import { computeSaleMetrics } from "@/lib/soldRecords";

const base: SoldLineInput = {
  name: "台積電",
  symbol: "2330",
  market: "TW",
  price: 950,
  rec: { id: "a", date: "2026-10-01", shares: 1000, buyPrice: 800, sellPrice: 900, remaining: 0, user: ["sellPrice", "date", "shares", "buyPrice"] },
  rating: { day: "2026-10-01", label: "先不要買", holdingLabel: "續抱" },
};

describe("已賣出區塊文字", () => {
  it("已確認：帶已實現損益、賣出後漲跌＝賣早了、若沒賣價差、賣出當天建議；數字與 computeSaleMetrics 一致", () => {
    const line = formatSoldLine(base, "2026-10-06");
    const m = computeSaleMetrics(base.rec, 950, "TW", "2026-10-06");
    expect(line).toContain("使用者已確認");
    expect(line).toContain("賣早了");
    expect(line).toContain(`${m.realizedPnl! >= 0 ? "+" : ""}${Math.round(m.realizedPnl!).toLocaleString("en-US")}`);
    expect(line).toContain("若沒賣價差 +50,000");
    expect(line).toContain("賣出當天本站建議：「續抱」");
    expect(line).not.toContain("估計值，未確認");
  });
  it("未確認要標（估計值，未確認）；沒評等紀錄寫無紀錄；缺賣出價不亂算", () => {
    const line = formatSoldLine({ ...base, rec: { ...base.rec, user: [], sellPrice: undefined }, rating: null }, "2026-10-06");
    expect(line).toContain("估計值，未確認");
    expect(line).toContain("賣出價 未填");
    expect(line).toContain("缺賣出價或現價");
    expect(line).toContain("賣出當天本站建議：無紀錄");
  });
  it("部分賣出標示剩餘股數；賣出後下跌＝賣對了", () => {
    const line = formatSoldLine({ ...base, price: 850, rec: { ...base.rec, remaining: 600 } }, "2026-10-06");
    expect(line).toContain("部分賣出（賣出後仍持有 600 股）");
    expect(line).toContain("賣對了");
  });
  it("彙總只算已確認的，未確認另外數", () => {
    const unconf = { ...base, rec: { ...base.rec, id: "b", user: [] as never[] } };
    const text = summarizeSoldLines([base, unconf, { ...base, price: 800, rec: { ...base.rec, id: "c" } }], "2026-10-06");
    expect(text).toContain("已確認 2 筆中：賣對了 1 筆、賣早了 1 筆");
    expect(text).toContain("另有 1 筆是估計值");
    expect(summarizeSoldLines([unconf], "2026-10-06")).toContain("尚無使用者已確認");
  });
});
