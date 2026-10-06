import { describe, expect, it } from "vitest";
import { applyRatingConfirmation } from "@/lib/ai/ratingStability";
import { computeSiteRating } from "@/lib/ai/siteRating";
import { sumChipsWindow } from "@/lib/ai/chipsWindow";
import { baseStateFor } from "@/lib/ai/ratingConfirmStore";
import type { Facet, Verdict } from "@/lib/ai/actionScoring";
import type { PriceFramework } from "@/lib/ai/grounding/priceLevels";

const NAMES = ["技術面", "籌碼面", "持股結構面（大戶／外資／融資／融券）", "基本面（估值）", "財報面"];
function facets(verdicts: Verdict[]) {
  const f: Facet[] = verdicts.map((v, i) => ({ name: NAMES[i], verdict: v, detail: i === 1 ? "近5個交易日三大法人累計-3,000,000股（約-3,000張）" : "" }));
  return { facets: f, supportCount: f.filter((x) => x.verdict === "支持").length, againstCount: f.filter((x) => x.verdict === "不支持").length };
}
const GOOD: Verdict[] = ["支持", "支持", "中性", "支持", "中性"];
const CHIPS_BAD: Verdict[] = ["支持", "不支持", "中性", "支持", "中性"];
const frame = (price: number, broke = false): PriceFramework => ({
  price,
  supports: [{ price: 100, labels: ["MA10"] }, { price: 95, labels: ["MA20"] }],
  resistances: [{ price: 110, labels: ["MA60"] }],
  zone: broke ? null : { low: 95, high: 100, lowLabel: "MA20", highLabel: "MA10" },
  exit: { price: 90, label: "MA60" },
  noChase: { price: 105, label: "近20日高" },
}) as PriceFramework;

describe("applyRatingConfirmation（新結論要連續 2 個交易日）", () => {
  const buy = { code: "buy" as const, holdingCode: "add" as const };
  const avoid = { code: "avoid" as const, holdingCode: "hold" as const };
  it("第一天變化先不換、第二天仍如此才換；中間回來就取消", () => {
    const d1 = applyRatingConfirmation(null, { ...buy, hardRisk: false, day: "2026-10-01" });
    const d2 = applyRatingConfirmation(d1, { ...avoid, hardRisk: false, day: "2026-10-02" });
    expect([d2.code, d2.pending?.code]).toEqual(["buy", "avoid"]);
    const d3 = applyRatingConfirmation(d2, { ...avoid, hardRisk: false, day: "2026-10-05" });
    expect([d3.code, d3.pending]).toEqual(["avoid", null]);
    const flicker = applyRatingConfirmation(applyRatingConfirmation(d1, { ...avoid, hardRisk: false, day: "b" }), { ...buy, hardRisk: false, day: "c" });
    expect([flicker.code, flicker.pending]).toEqual(["buy", null]);
  });
  it("破底（硬性風險）立即生效；持有建議大類（續抱→減碼）也要確認", () => {
    const d1 = applyRatingConfirmation(null, { ...buy, hardRisk: false, day: "a" });
    expect(applyRatingConfirmation(d1, { code: "avoid", holdingCode: "exit", hardRisk: true, day: "b" }).holdingCode).toBe("exit");
    const h1 = applyRatingConfirmation(null, { ...avoid, hardRisk: false, day: "a" });
    const h2 = applyRatingConfirmation(h1, { code: "avoid", holdingCode: "reduce", hardRisk: false, day: "b" });
    expect([h2.holdingCode, h2.pending?.holdingCode]).toEqual(["hold", "reduce"]);
  });
});

describe("computeSiteRating＋確認：維持前一交易日結論時，字樣與價位依今天資料重組並說明", () => {
  const prevBuy = applyRatingConfirmation(null, { code: "buy", holdingCode: "add", hardRisk: false, day: "2026-10-05" });
  it("昨天建議買進、今天只有籌碼轉不支持 → 今天仍建議買進，附『明天仍如此才改判』", () => {
    const r = computeSiteRating({ ...facets(CHIPS_BAD), signals: [], framework: frame(99), confirm: { prev: prevBuy, day: "2026-10-06" } });
    expect(r.code).toBe("buy");
    expect(r.label).toBe("建議買進");
    expect(r.holdingLabel).toBe("可分批加碼");
    expect(r.pendingChange).toMatch(/今天的資料指向未持有「建議先不要買」.*連續 2 個交易日確認/);
    expect(r.reason).toContain("前一交易日評等為建議買進");
    expect(r.confirmState?.pending?.code).toBe("avoid");
  });
  it("第二天仍不支持 → 改判先不要買；破底當天就改判", () => {
    const d2 = computeSiteRating({ ...facets(CHIPS_BAD), signals: [], framework: frame(99), confirm: { prev: prevBuy, day: "2026-10-06" } });
    const d3 = computeSiteRating({ ...facets(CHIPS_BAD), signals: [], framework: frame(99), confirm: { prev: d2.confirmState!, day: "2026-10-07" } });
    expect([d3.code, d3.pendingChange]).toEqual(["avoid", null]);
    const broke = computeSiteRating({ ...facets(GOOD), signals: [], framework: frame(80, true), confirm: { prev: prevBuy, day: "2026-10-06" } });
    expect([broke.code, broke.holdingCode]).toEqual(["avoid", "exit"]);
  });
  it("昨天先不要買、今天達門檻 → 先維持先不要買，改判條件寫明天仍達門檻", () => {
    const prevAvoid = applyRatingConfirmation(null, { code: "avoid", holdingCode: "hold", hardRisk: false, day: "2026-10-05" });
    const r = computeSiteRating({ ...facets(GOOD), signals: [], framework: frame(99), confirm: { prev: prevAvoid, day: "2026-10-06" } });
    expect([r.code, r.holdingLabel]).toEqual(["avoid", "續抱觀察、不加碼"]);
    expect(r.upgradeCondition).toContain("下一個交易日仍達買進門檻");
    expect(r.reason).toContain("今天已達買進門檻，但前一交易日評等為建議先不要買");
  });
  it("沒給 confirm＝舊行為（回測比較用）", () => {
    expect(computeSiteRating({ ...facets(CHIPS_BAD), signals: [], framework: frame(99) }).code).toBe("avoid");
  });
});

describe("sumChipsWindow／baseStateFor", () => {
  it("取最後 n 天累計；不足 n 天回 null", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((k) => ({ date: `2026-10-0${k}`, foreign: k * 10, trust: -k, dealer: 1 }));
    const w = sumChipsWindow(rows, 5)!;
    expect(w).toEqual({ days: 5, lastDate: "2026-10-06", institutionalNetShares: 200 - 20 + 5, foreignNetShares: 200, trustNetShares: -20 });
    expect(sumChipsWindow(rows.slice(0, 4), 5)).toBeNull();
  });
  it("今天已算過用存的 base；較早的一天用 cur；太久沒算回 null", () => {
    const cur = { code: "buy" as const, holdingCode: "add" as const, pending: null, day: "2026-10-05" };
    const base = { ...cur, code: "avoid" as const, day: "2026-10-02" };
    expect(baseStateFor({ cur, base }, "2026-10-05")).toBe(base);
    expect(baseStateFor({ cur, base }, "2026-10-06")).toBe(cur);
    expect(baseStateFor({ cur, base }, "2026-10-20")).toBeNull();
    expect(baseStateFor(null, "2026-10-06")).toBeNull();
  });
});
