import { describe, expect, it } from "vitest";
import { describeRatingChange, RATING_CHANGE_TITLE } from "@/lib/ai/ratingChange";
import type { RatingLogEntry } from "@/lib/ai/ratingLog";

const prev = (code: RatingLogEntry["code"], label: string, facets: Record<string, string> = {}, price = 270): RatingLogEntry =>
  ({ at: "2026-10-05T05:00:00Z", day: "2026-10-05", session: "盤中", symbol: "1303", name: "南亞", market: "TW", price, code, label, holdingLabel: "", reason: "", facets, zone: null, noChase: null, exit: null, chaseHits: [], source: "ai-ask" }) as RatingLogEntry;
const cur = (code: "buy" | "avoid", label: string, facets: Array<{ name: string; verdict: string }> = [], price = 286) => ({
  name: "南亞",
  symbol: "1303",
  price,
  rating: { code, label },
  facets,
});

describe("評等與前一交易日不同（2026-10-06 南亞：昨天說不要追高、今天建議買進）", () => {
  it("舊評等等回檔 → 今天建議買進：照實說是規則改版，附價格變化", () => {
    const t = describeRatingChange(prev("buy-on-pullback", "建議等回檔再買（現價不買，等回到 250～260）"), cur("buy", "建議買進"))!;
    expect(t.startsWith(RATING_CHANGE_TITLE)).toBe(true);
    expect(t).toContain("10/5本站評等是「建議等回檔再買（現價不買，等回到 250～260）」，現在是「建議買進」");
    expect(t).toContain("評等規則改版");
    expect(t).toContain("股價由 270 變為 286（+5.9%）");
  });

  it("先不要買 → 建議買進：列出改變的面向", () => {
    const t = describeRatingChange(
      prev("avoid", "建議先不要買", { 技術面: "不支持", 籌碼面: "支持" }, 286),
      cur("buy", "建議買進", [{ name: "技術面", verdict: "支持" }, { name: "籌碼面", verdict: "支持" }])
    )!;
    expect(t).toContain("技術面由【不支持】變【支持】");
    expect(t).not.toContain("規則改版");
  });

  it("買不買大類沒變（只是價位字樣不同）→ 不附", () => {
    expect(describeRatingChange(prev("buy", "建議買進"), cur("buy", "建議買進（現價 286 可分批買；若拉回到 270 附近可加碼）"))).toBeNull();
    expect(describeRatingChange(prev("avoid", "建議先不要買"), cur("avoid", "建議先不要買"))).toBeNull();
  });
});
