import { describe, expect, it } from "vitest";
import { computeSiteRating, ratingConfidence } from "@/lib/ai/siteRating";
import { HOLDING_STRUCTURE_FACET_NAME, type Facet, type Verdict } from "@/lib/ai/actionScoring";
import type { PriceFramework } from "@/lib/ai/grounding/priceLevels";
import { evaluateIndicator, normalizeParams, type EvalContext, type RatingDetail } from "@/lib/strategy/indicatorCatalog";
import { evaluateStrategy, normalizeStrategyConfig, type UserIndicator } from "@/lib/strategy/engine";
import { AI_FULL_TEMPLATE_ID, TEMPLATE_MAP } from "@/lib/strategy/templates";

const FACET_NAMES = ["技術面", "籌碼面", HOLDING_STRUCTURE_FACET_NAME, "基本面（估值）", "財報面"];
const VERDICTS: Verdict[] = ["支持", "中性", "不支持", "無資料"];

const frameOk: PriceFramework = {
  price: 100,
  supports: [{ price: 97, label: "MA20" } as never],
  resistances: [],
  zone: { low: 96, high: 98, lowLabel: "MA60", highLabel: "MA20" },
  exit: { price: 94, label: "支撐下方" },
  noChase: { price: 103, label: "不追價" },
};
const frameBroken: PriceFramework = { ...frameOk, supports: [], zone: null, exit: null };

function detailOf(facets: Facet[], framework: PriceFramework) {
  const supportCount = facets.filter((f) => f.verdict === "支持").length;
  const againstCount = facets.filter((f) => f.verdict === "不支持").length;
  const rating = computeSiteRating({ facets, supportCount, againstCount, signals: [], framework });
  const detail: RatingDetail = {
    facets: facets.map((f) => ({ name: f.name, verdict: f.verdict })),
    supportCount,
    againstCount,
    brokeDown: !framework.zone,
    zoneLow: rating.zone?.low ?? null,
    zoneHigh: rating.zone?.high ?? null,
    price: framework.price,
    holdingCode: rating.holdingCode,
    confidence: ratingConfidence(rating)?.level ?? null,
  };
  return { rating, detail };
}

describe("AI 策略・完整版（本站評等拆成策略條件）", () => {
  const t = TEMPLATE_MAP.get(AI_FULL_TEMPLATE_ID)!;
  const indicators: UserIndicator[] = t.indicators.map((i) => ({ id: i.key, name: i.key, typeId: i.typeId, params: normalizeParams(i.typeId, i.params) }));
  const cfg = normalizeStrategyConfig(
    { mode: "rules", buy: { ids: t.buy.keys, match: t.buy.match }, sell: { ids: t.sell.keys, match: t.sell.match } },
    new Set(t.indicators.map((i) => i.key)),
  );

  it("所有面向組合（4^5）× 破底與否：買進＝本站「建議買進」、賣出＝本站「建議出場或減碼」，逐一相同", () => {
    let n = 0;
    let buys = 0;
    for (let mask = 0; mask < 4 ** 5; mask++) {
      const facets: Facet[] = FACET_NAMES.map((name, i) => ({ name, verdict: VERDICTS[Math.floor(mask / 4 ** i) % 4], detail: "" }));
      for (const framework of [frameOk, frameBroken]) {
        const { rating, detail } = detailOf(facets, framework);
        const ctx: EvalContext = { symbol: "T", market: "TW", candles: [], ratingDetail: detail, ratingCode: rating.code };
        const d = evaluateStrategy(cfg, indicators, ctx);
        expect(d.buy, `${facets.map((f) => f.verdict).join(",")} 破底=${!framework.zone}`).toBe(rating.code === "buy");
        expect(d.sell, `${facets.map((f) => f.verdict).join(",")} 破底=${!framework.zone}`).toBe(rating.holdingCode === "exit" || rating.holdingCode === "reduce");
        n++;
        if (d.buy) buys++;
      }
    }
    expect(n).toBe(2048);
    expect(buys).toBeGreaterThan(0);
  });

  it("單一指標：面向、面向數、價位框架、持有中建議、把握程度", () => {
    const facets: Facet[] = FACET_NAMES.map((name, i) => ({ name, verdict: (["支持", "支持", "中性", "不支持", "無資料"] as Verdict[])[i], detail: "" }));
    const { detail } = detailOf(facets, frameOk);
    const ctx: EvalContext = { symbol: "T", market: "TW", candles: [], ratingDetail: detail };
    expect(evaluateIndicator("rating_facet", { facet: "tech", verdict: "support" }, ctx).pass).toBe(true);
    expect(evaluateIndicator("rating_facet", { facet: "value", verdict: "against" }, ctx).pass).toBe(true);
    expect(evaluateIndicator("rating_facet", { facet: "value", verdict: "notAgainst" }, ctx).pass).toBe(false);
    expect(evaluateIndicator("rating_facet", { facet: "earnings", verdict: "notAgainst" }, ctx).pass).toBe(true);
    expect(evaluateIndicator("rating_facet_count", { kind: "support", op: "gte", n: 2 }, ctx).pass).toBe(true);
    expect(evaluateIndicator("rating_facet_count", { kind: "against", op: "lte", n: 0 }, ctx).pass).toBe(false);
    expect(evaluateIndicator("rating_price_frame", { cond: "notBroken" }, ctx).pass).toBe(true);
    expect(evaluateIndicator("rating_price_frame", { cond: "nearZone", pct: 1 }, ctx).pass).toBe(false); // 100 高於上緣 98 約 2%
    expect(evaluateIndicator("rating_price_frame", { cond: "nearZone", pct: 3 }, ctx).pass).toBe(true);
    expect(evaluateIndicator("rating_holding", { code: "exitOrReduce" }, ctx).pass).toBe(false);
    expect(evaluateIndicator("rating_confidence", { min: "low" }, ctx).pass).toBe(true); // 建議買進，沒有確認狀態＝剛轉買→中
    expect(evaluateIndicator("rating_confidence", { min: "high" }, ctx).pass).toBe(false);
    // 沒有評等資料＝資料不足
    expect(evaluateIndicator("rating_facet", { facet: "tech", verdict: "support" }, { symbol: "T", market: "TW", candles: [] }).pass).toBeNull();
  });
});
