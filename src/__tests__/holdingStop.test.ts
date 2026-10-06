import { describe, expect, it } from "vitest";
import { computeHoldingStop, describeHoldingStop, HOLDING_STOP_MAX_PCT, HOLDING_STOP_TITLE } from "@/lib/ai/holdingStop";
import { describeRatingForHolding, formatHoldingRatingSummary, HOLDING_SUMMARY_TITLE } from "@/lib/ai/holdingRating";
import type { SiteRating } from "@/lib/ai/siteRating";
import {
  DEEPER_ANALYSIS_REQUEST_PATTERN,
  HOLDINGS_ANALYSIS_INTENT_PATTERN,
  HOLDINGS_DECISION_PATTERN,
  HOLDINGS_TOPIC_PATTERN,
  JUDGMENT_QUESTION_PATTERN,
} from "@/lib/ai/intent";

/** closes（舊→新）→ 日K，高低各 ±spread。 */
const candlesOf = (closes: number[], spread = 0.3) =>
  closes.map((c, i) => ({ time: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), close: c, high: c + spread, low: c - spread }));

describe("computeHoldingStop（持有中出場價，2026-10-05 使用者回報停損價離譜）", () => {
  it("友達 2409：現價 39.05、成本 36.48 → 用近端均線當移動停利，不是 32.65；距現價 ≤8% 且高於跌停 35.15", () => {
    // 前 10 天 35、後 10 天 38：MA10=38、MA20=36.5、近10日低=37.7
    const candles = candlesOf([...Array(10).fill(35), ...Array(10).fill(38)]);
    const s = computeHoldingStop({ candles, price: 39.05, costBasis: 36.48, market: "TW" })!;
    expect(s.price).toBe(38);
    expect(s.label).toBe("MA10");
    expect(s.kind).toBe("trailing-profit");
    expect(s.capped).toBe(false);
    expect(s.limitDown).toBe(35.15);
    expect(s.price).toBeGreaterThan(s.limitDown!);
    expect(s.price).toBeGreaterThanOrEqual(39.05 * (1 - HOLDING_STOP_MAX_PCT));
    expect(s.price).not.toBe(32.65);
  });

  it("和益 1709：現價 64.3、均線都在 45 附近（−30%）→ 改用現價下方 8%（59.2），標明支撐太遠", () => {
    const candles = candlesOf([...Array(15).fill(42.5), 44, 46, 48, 52, 60]);
    const s = computeHoldingStop({ candles, price: 64.3, costBasis: 39.45, market: "TW" })!;
    expect(s.capped).toBe(true);
    expect(s.price).toBe(59.2);
    expect(s.label).toContain("太遠");
    expect(s.kind).toBe("trailing-profit");
    expect(s.price).toBeGreaterThan(s.limitDown!);
    expect(s.pctBelow).toBeLessThanOrEqual(HOLDING_STOP_MAX_PCT * 100);
  });

  it("已虧損 → 停損；目前小賺但出場價低於成本 → protect", () => {
    const candles = candlesOf([...Array(10).fill(42), ...Array(10).fill(40)]);
    expect(computeHoldingStop({ candles, price: 41, costBasis: 50, market: "TW" })!.kind).toBe("stop-loss");
    expect(computeHoldingStop({ candles, price: 41, costBasis: 40.5, market: "TW" })!.kind).toBe("protect");
  });

  it("太貼近現價（<1%）的均線不當出場價", () => {
    // MA10≈99.8（貼現價 100）、MA20≈97.4 → 取 97.4 附近
    const candles = candlesOf([...Array(10).fill(95), ...Array(10).fill(99.8)], 0.1);
    const s = computeHoldingStop({ candles, price: 100, costBasis: 90, market: "TW" })!;
    expect(s.price).toBeLessThan(99);
  });

  it("興櫃／美股沒有跌停價", () => {
    const candles = candlesOf(Array(20).fill(100));
    expect(computeHoldingStop({ candles, price: 105, market: "TW", emerging: true })!.limitDown).toBeNull();
    expect(computeHoldingStop({ candles, price: 105, market: "US" })!.limitDown).toBeNull();
  });

  it("文字說明：移動停利／停損字樣與『不可用買進後跌破 X 出場』", () => {
    const candles = candlesOf([...Array(10).fill(35), ...Array(10).fill(38)]);
    const s = computeHoldingStop({ candles, price: 39.05, costBasis: 36.48, market: "TW" })!;
    const t = describeHoldingStop(s, 39.05, 36.48);
    expect(t.startsWith(HOLDING_STOP_TITLE)).toBe(true);
    expect(t).toContain("移動停利價 38");
    expect(t).toContain("跌停價約 35.15");
  });
});

const baseRating: SiteRating = {
  code: "buy-on-pullback",
  label: "建議等回檔再買（現價不買，等回到 30～33）",
  holdingCode: "hold",
  holdingLabel: "續抱",
  reason: "測試",
  supportCount: 3,
  againstCount: 0,
  zone: { low: 30, high: 33 },
  noChase: 40,
  exit: 32.65,
  chaseHits: [],
  riskNote: null,
};

describe("describeRatingForHolding（三條路徑共用的含成本評等）", () => {
  const candles = candlesOf([...Array(10).fill(35), ...Array(10).fill(38)]);
  const rated = { name: "友達", symbol: "2409", price: 39.05, rating: baseRating };

  it("持有中：不印遠端出場價 32.65，改附持有中出場參考", () => {
    const r = describeRatingForHolding(rated, { costBasis: 36.48, market: "TW" }, candles);
    expect(r.held).toBe(true);
    expect(r.text).not.toContain("跌破 32.65");
    expect(r.text).toContain(HOLDING_STOP_TITLE);
  });

  it("未持有：照原評等（含買進後出場價）", () => {
    const r = describeRatingForHolding(rated, null, candles);
    expect(r.held).toBe(false);
    expect(r.text).toContain("買進後跌破 32.65 出場");
  });

  it("曾獲利 ≥8% 又跌回成本 → 建議減碼（單一動作），並列進彙整的『該賣』（附目前虧損%）", () => {
    // 成本 40，期間最高 44（+10%），現價 39.5 跌回成本以下
    const c = candlesOf([...Array(10).fill(40), 44, 43, 42, 41, 40, 40, 39.8, 39.6, 39.5, 39.5]);
    // 沒有買進日 → 不觸發停利（不再用日K近似）
    expect(describeRatingForHolding({ ...rated, price: 39.5 }, { costBasis: 40, market: "TW" }, c).rating.holdingCode).not.toBe("reduce");
    expect(describeRatingForHolding({ ...rated, price: 39.5 }, { costBasis: 40, market: "TW" }, c).text).not.toMatch(/買進.{0,6}後最高約|曾漲到/);
    const r = describeRatingForHolding({ ...rated, price: 39.5 }, { costBasis: 40, buyDate: "2026-09-01", market: "TW" }, c);
    expect(r.rating.holdingCode).toBe("reduce");
    expect(r.text).toContain("買進（09/01）後最高約 44.3");
    // 買進日晚於那個高點（高點在 09/11）→ 只看之後的，不觸發
    expect(describeRatingForHolding({ ...rated, price: 39.5 }, { costBasis: 40, buyDate: "2026-09-13", market: "TW" }, c).rating.holdingCode).not.toBe("reduce");
    const keep = describeRatingForHolding(rated, { costBasis: 36.48, market: "TW" }, candles);
    const summary = formatHoldingRatingSummary([
      { name: "A", symbol: "1528", ...r },
      { name: "B", symbol: "2409", ...keep },
      undefined,
    ]);
    expect(summary.startsWith(HOLDING_SUMMARY_TITLE)).toBe(true);
    expect(summary).toMatch(/該賣）的：A\(1528\)「建議減碼（買進後曾獲利約 \d+%，現已跌回成本以下）」（目前虧損約 1\.2%）；/);
    expect(summary).toMatch(/不用賣）：B\(2409\)「續抱」（目前獲利約 [\d.]+%）/);
  });

  it("沒有持有中 → 不產生彙整", () => {
    expect(formatHoldingRatingSummary([describeRatingForHolding(rated, null, candles) as never])).toBe("");
  });
});

describe("持股決策意圖（第二題要套同一套含成本評等）", () => {
  const q2 = "那我持有名單現在建議盤後賣掉哪些?直接列出來給我就好不用說明。";
  it("「賣掉哪些」＝談持股且在做決策（附評等），不是深度分析", () => {
    expect(HOLDINGS_TOPIC_PATTERN.test(q2)).toBe(true);
    expect(HOLDINGS_DECISION_PATTERN.test(q2)).toBe(true);
    expect(HOLDINGS_ANALYSIS_INTENT_PATTERN.test(q2)).toBe(false);
  });
  it("第一題仍是深度分析", () => {
    expect(HOLDINGS_ANALYSIS_INTENT_PATTERN.test("幫我分析一下我關注清單裡的每一檔股票")).toBe(true);
  });
  it("判斷題／再多分析放寬長度", () => {
    expect(JUDGMENT_QUESTION_PATTERN.test("仁寶何時進場")).toBe(true);
    expect(DEEPER_ANALYSIS_REQUEST_PATTERN.test("再多分析")).toBe(true);
    expect(JUDGMENT_QUESTION_PATTERN.test("台積電本益比多少")).toBe(false);
  });
});
