import { describe, expect, it } from "vitest";
import { describeRatingChange, ensureRatingChangeExplained, RATING_CHANGE_APPENDIX_TITLE, RATING_CHANGE_TITLE } from "@/lib/ai/ratingChange";
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
    expect(t).toContain("未持有：10/5「建議等回檔再買（現價不買，等回到 250～260）」→現在「建議買進」");
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

describe("持有中的持有建議改變（2026-10-06 使用者：昨天建議我賣我才賣，今天又不一樣）", () => {
  const p2 = (holdingLabel: string, facets: Record<string, string>) => ({ ...prev("avoid", "建議先不要買", facets, 50), holdingLabel });
  it("續抱 → 減碼（買不買大類沒變）也要說明，附面向現在的數字", () => {
    const t = describeRatingChange(p2("續抱觀察、不加碼", { 籌碼面: "支持" }), {
      name: "陽明",
      symbol: "2609",
      price: 49,
      held: true,
      rating: { code: "avoid", label: "建議先不要買", holdingLabel: "建議減碼" },
      facets: [{ name: "籌碼面", verdict: "不支持", detail: "三大法人合計-3,200,000股（約-3,200張）" }],
    })!;
    expect(t).toContain("已持有：10/5「續抱觀察、不加碼」→現在「建議減碼」");
    expect(t).toContain("籌碼面由【支持】變【不支持】（現在：三大法人合計-3,200,000股（約-3,200張））");
    expect(t).not.toContain("未持有：");
  });
  it("沒持有時只看買不買；持有建議同類（續抱→可分批加碼）不附", () => {
    const base = { name: "陽明", symbol: "2609", price: 49, facets: [] };
    expect(describeRatingChange(p2("續抱觀察、不加碼", {}), { ...base, rating: { code: "avoid", label: "建議先不要買", holdingLabel: "建議減碼" } })).toBeNull();
    expect(describeRatingChange(p2("續抱", {}), { ...base, held: true, rating: { code: "avoid", label: "建議先不要買", holdingLabel: "可分批加碼" } })).toBeNull();
  });
});

describe("ensureRatingChangeExplained（回答沒交代評等變動就補程式說明）", () => {
  const g = `${RATING_CHANGE_TITLE}陽明(2609)：已持有：10/5「續抱」→現在「建議減碼」。原因：面向改變：籌碼面由【支持】變【不支持】。
`;
  it("提到陽明但沒說跟前一天不同 → 補在最後", () => {
    const r = ensureRatingChangeExplained("陽明(2609)：建議減碼，法人賣超。", g);
    expect(r.appended).toEqual(["2609"]);
    expect(r.text).toContain(`${RATING_CHANGE_APPENDIX_TITLE}：
- 陽明(2609)：已持有：10/5「續抱」→現在「建議減碼」`);
    expect(r.text).not.toContain(RATING_CHANGE_TITLE);
  });
  it("已交代（跟昨天不同）或根本沒提到 → 不補", () => {
    expect(ensureRatingChangeExplained("陽明：建議減碼，跟昨天的續抱不同，因為法人轉賣超。", g).appended).toEqual([]);
    expect(ensureRatingChangeExplained("台積電：續抱。", g).appended).toEqual([]);
  });
});
