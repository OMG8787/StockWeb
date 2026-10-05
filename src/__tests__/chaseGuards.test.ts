import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/data/types";
import type { Facet, Verdict } from "@/lib/ai/actionScoring";
import type { PriceFramework } from "@/lib/ai/grounding/priceLevels";
import {
  ACTIVE_CHASE_GUARDS,
  CHASE_RET5_MAX_PCT,
  computeChaseMetrics,
  evaluateChaseGuards,
  type ChaseMetrics,
} from "@/lib/ai/chaseGuards";
import { applyHoldingCost, checkTakeProfit, computeSiteRating, TAKE_PROFIT_PEAK_GAIN_PCT } from "@/lib/ai/siteRating";
import { groupedPickLines, PULLBACK_GROUP_TITLE, type ActionBriefPick } from "@/lib/ai/actionBrief";

function candles(closes: number[], startDay = 1): Candle[] {
  return closes.map((c, i) => ({
    time: `2026-08-${String(startDay + i).padStart(2, "0")}`,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1_000_000,
  }));
}

const NAMES = ["技術面", "籌碼面", "持股結構面（大戶／外資／融資／融券）", "基本面（估值）", "財報面"];
function facets(verdicts: Verdict[]) {
  const f: Facet[] = verdicts.map((v, i) => ({ name: NAMES[i], verdict: v, detail: "" }));
  return { facets: f, supportCount: f.filter((x) => x.verdict === "支持").length, againstCount: f.filter((x) => x.verdict === "不支持").length };
}
const GOOD: Verdict[] = ["支持", "支持", "中性", "支持", "中性"];
const frame = (price: number): PriceFramework => ({
  price,
  supports: [{ price: 100, labels: ["MA10"] }, { price: 95, labels: ["MA20"] }],
  resistances: [],
  zone: { low: 95, high: 100, lowLabel: "MA20", highLabel: "MA10" },
  exit: { price: 90, label: "MA60" },
  noChase: { price: 105, label: "近20日高" },
});
const calm: ChaseMetrics = {
  rsi: 55, ret5: 2, ret10: 3, ret20: 5, limitUpWithin3: false, ma20BiasPct: 2, ma60BiasPct: 5, foreignSellPctOfAvgVol: null,
};

describe("computeChaseMetrics", () => {
  it("用 asOfDay 之前的K棒當過去、現價當今天：5日漲幅、漲停、乖離", () => {
    const cs = candles(Array.from({ length: 25 }, () => 100));
    const m = computeChaseMetrics(cs, 110, "2026-08-26", -50_000);
    expect(m.ret5).toBeCloseTo(10);
    expect(m.limitUpWithin3).toBe(true);
    expect(m.ma20BiasPct).toBeCloseTo((110 / ((110 + 19 * 100) / 20) - 1) * 100);
    expect(m.ma60BiasPct).toBeNull(); // 日K不足 60 根
    expect(m.foreignSellPctOfAvgVol).toBeCloseTo(5);
  });

  it("日K已含今天那根時以現價取代，不會重複算", () => {
    const cs = candles([...Array.from({ length: 24 }, () => 100), 120]); // 第 25 根＝今天 08-25
    const m = computeChaseMetrics(cs, 110, "2026-08-25");
    expect(m.ret5).toBeCloseTo(10);
  });
});

describe("evaluateChaseGuards", () => {
  it("現行只採用②急漲（回測只有它在推薦組與全樣本都有效）", () => {
    expect(ACTIVE_CHASE_GUARDS).toEqual(["surge"]);
  });

  it("5日漲幅超過門檻 → 觸發急漲；RSI 過熱只在指定時才觸發", () => {
    const m = { ...calm, ret5: CHASE_RET5_MAX_PCT + 1, rsi: 80 };
    expect(evaluateChaseGuards(m).map((h) => h.id)).toEqual(["surge"]);
    expect(evaluateChaseGuards(m, ["rsi", "surge"]).map((h) => h.id)).toEqual(["rsi", "surge"]);
  });

  it("近3日漲停但20日漲幅未過門檻 → 不觸發", () => {
    expect(evaluateChaseGuards({ ...calm, limitUpWithin3: true, ret20: 20 })).toEqual([]);
    expect(evaluateChaseGuards({ ...calm, limitUpWithin3: true, ret20: 30 }).map((h) => h.id)).toEqual(["surge"]);
  });
});

describe("computeSiteRating＋追高防護", () => {
  it("體質過關、價位貼近區間，近5日急漲 → 結論維持建議買進，只附短線波動風險提示（2026-10-05 擴大回測）", () => {
    const r = computeSiteRating({ ...facets(GOOD), signals: [], framework: frame(100.5), chase: { ...calm, ret5: 18 } });
    expect(r.code).toBe("buy");
    expect(r.label).toBe("建議買進");
    expect(r.riskNote).toContain("短線波動風險：近5日已漲 18%");
    expect(r.reason).toContain("若要買宜分批、降低部位");
    // 評等紀錄仍記錄 surge 觸發（給學習循環用）
    expect(r.chaseHits.map((h) => h.id)).toEqual(["surge"]);
  });

  it("技術面不支持 → 一票否決為先不要買（即使其他面向支持、不支持只有 1 項）", () => {
    const r = computeSiteRating({ ...facets(["不支持", "支持", "支持", "支持", "中性"]), signals: [], framework: frame(100.5), chase: calm });
    expect(r.code).toBe("avoid");
    expect(r.reason).toContain("技術面不支持");
    expect(r.reason).toContain("一票否決");
    expect(r.riskNote).toBeNull();
  });

  it("先不要買時不附追價風險提示", () => {
    const r = computeSiteRating({ ...facets(["中性", "不支持", "支持", "中性", "中性"]), signals: [], framework: frame(100.5), chase: { ...calm, ret5: 18 } });
    expect(r.code).toBe("avoid");
    expect(r.riskNote).toBeNull();
  });

  it("沒觸發 → 維持建議買進；沒給 chase（回測基準）→ 不套防護", () => {
    expect(computeSiteRating({ ...facets(GOOD), signals: [], framework: frame(100.5), chase: calm }).code).toBe("buy");
    expect(computeSiteRating({ ...facets(GOOD), signals: [], framework: frame(100.5) }).code).toBe("buy");
  });

  it("指定 foreignSell 防護時，外資大賣 → 先不要買", () => {
    const r = computeSiteRating({
      ...facets(GOOD), signals: [], framework: frame(100.5), chase: { ...calm, foreignSellPctOfAvgVol: 5 }, guards: ["foreignSell"],
    });
    expect(r.code).toBe("avoid");
    expect(r.reason).toContain("外資單日賣超");
  });
});

describe("持有中停利提示", () => {
  const cs = [
    { high: 101, low: 99 }, // 買進日（涵蓋成本 100）
    { high: 112, low: 104 }, // 曾漲到 112（+12%）
    { high: 105, low: 99 },
  ];

  it("曾獲利 ≥8% 後現價跌回成本以下 → 觸發，套到已持有結論", () => {
    const check = checkTakeProfit(100, cs, 99);
    expect(check?.peakGainPct).toBeCloseTo(12);
    expect(check!.peakGainPct).toBeGreaterThanOrEqual(TAKE_PROFIT_PEAK_GAIN_PCT);
    const base = computeSiteRating({ ...facets(GOOD), signals: [], framework: frame(110) });
    const r = applyHoldingCost(base, check);
    expect(r.holdingCode).toBe("reduce");
    expect(r.holdingLabel).toBe("建議減碼或出場（獲利已吐回）");
    expect(r.reason).toContain("近似");
    expect(r.label).toBe(base.label); // 未持有結論不變
  });

  it("現價仍高於成本、或從沒獲利到 8% → 不觸發", () => {
    expect(checkTakeProfit(100, cs, 101)).toBeNull();
    expect(checkTakeProfit(100, [{ high: 105, low: 99 }], 98)).toBeNull();
  });

  it("買進日之前的高點不算（日K第一根涵蓋成本的那天才開始）", () => {
    expect(checkTakeProfit(100, [{ high: 130, low: 120 }, { high: 101, low: 99 }, { high: 103, low: 99 }], 99)).toBeNull();
  });

  it("原本就是出場 → 維持出場", () => {
    const base = { ...computeSiteRating({ ...facets(GOOD), signals: [], framework: frame(110) }), holdingCode: "exit" as const };
    expect(applyHoldingCost(base, checkTakeProfit(100, cs, 99)).holdingCode).toBe("exit");
  });
});

describe("groupedPickLines（今日建議 fallback 分組）", () => {
  const pick = (symbol: string, code: ActionBriefPick["code"], label: string): ActionBriefPick => ({
    symbol, name: `股${symbol}`, code, label, holdingLabel: "續抱", reason: "理由",
  });
  const stance = { briefMode: "today" as const, nextOpenLabel: "10/6（二）" };

  it("建議買進與等回檔分兩組，等回檔組標題明講現價不買", () => {
    const lines = groupedPickLines(
      [pick("1111", "buy-on-pullback", "建議等回檔再買（現價不買，等回到 95～100）"), pick("2222", "buy", "建議買進")],
      stance
    );
    expect(lines[0]).toBe("**建議買進（現價可分批買）**");
    expect(lines[1]).toContain("股2222");
    expect(lines[2]).toBe(`**${PULLBACK_GROUP_TITLE}**`);
    expect(lines[3]).toContain("現價不買");
  });

  it("只有等回檔 → 建議買進那塊寫「目前沒有現價可直接買的」", () => {
    const lines = groupedPickLines([pick("1111", "buy-on-pullback", "建議等回檔再買（現價不買，等回到 95～100）")], stance);
    expect(lines[1]).toContain("目前沒有現價可直接買的");
    expect(lines).toContain(`**${PULLBACK_GROUP_TITLE}**`);
  });

  it("兩組都沒有 → 觀望", () => {
    expect(groupedPickLines([], stance)[1]).toContain("今天觀望");
  });

  it("14:30 後（明日操作建議）：等回檔寫成盤中回到區間可分批買，不寫「開盤沒有可直接買的」", () => {
    const next = { briefMode: "next-open" as const, nextOpenLabel: "10/6（週二）" };
    const lines = groupedPickLines([pick("1111", "buy-on-pullback", "建議等回檔再買（現價不買，等回到 95～100）")], next);
    expect(lines[0]).toBe("**10/6（週二） 可買（建議買進）**");
    expect(lines.join("\n")).not.toContain("開盤沒有可直接買的");
    expect(lines[1]).toContain("盤中回到區間可分批買");
    expect(groupedPickLines([], next)[1]).toContain("10/6（週二） 先觀望");
  });
});
