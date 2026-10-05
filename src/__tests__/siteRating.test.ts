import { describe, expect, it } from "vitest";
import type { Facet, Verdict } from "@/lib/ai/actionScoring";
import type { PriceFramework } from "@/lib/ai/grounding/priceLevels";
import type { Signal } from "@/lib/signals";
import { computeSiteRating, describeSiteRating, isRecommendable, SITE_RATING_TITLE, stripRatingTags } from "@/lib/ai/siteRating";

const NAMES = ["技術面", "籌碼面", "持股結構面（大戶／外資／融資／融券）", "基本面（估值）", "財報面"];

function facets(verdicts: Verdict[]): { facets: Facet[]; supportCount: number; againstCount: number } {
  const f = verdicts.map((v, i) => ({ name: NAMES[i], verdict: v, detail: "" }));
  return {
    facets: f,
    supportCount: f.filter((x) => x.verdict === "支持").length,
    againstCount: f.filter((x) => x.verdict === "不支持").length,
  };
}

/** 現價 price、區間 low～high、出場 exit、不追 noChase。zone=null 表示破底。 */
function frame(price: number, zone: [number, number] | null, exit = 90, noChase = price * 1.03): PriceFramework {
  return {
    price,
    supports: zone ? [{ price: zone[1], labels: ["MA10"] }, { price: zone[0], labels: ["MA20"] }] : [],
    resistances: [{ price: price * 1.05, labels: ["近20日高"] }],
    zone: zone ? { low: zone[0], high: zone[1], lowLabel: "MA20", highLabel: "MA10" } : null,
    exit: zone ? { price: exit, label: "MA60" } : null,
    noChase: { price: noChase, label: "近20日高" },
  };
}

const sig = (label: string, tone: Signal["tone"] = "up"): Signal => ({ label, tone }) as Signal;
const GOOD: Verdict[] = ["支持", "支持", "中性", "支持", "中性"]; // 3 支持、0 不支持

describe("computeSiteRating", () => {
  it("體質過門檻＋現價貼近區間上緣（<1%）→ 建議買進、持有可加碼", () => {
    const r = computeSiteRating({ ...facets(GOOD), signals: [], framework: frame(100.5, [95, 100]) });
    expect(r.code).toBe("buy");
    expect(r.label).toBe("建議買進");
    expect(r.holdingCode).toBe("add");
    expect(isRecommendable(r)).toBe(true);
  });

  it("體質過門檻但現價高於區間上緣 ≥1% → 果斷建議買進（現價可分批買＋單一拉回加碼價），不再出現「現價不買」", () => {
    const r = computeSiteRating({ ...facets(GOOD), signals: [], framework: frame(110, [95, 100]) });
    expect(r.code).toBe("buy");
    expect(r.label).toBe("建議買進（現價 110 可分批買；若拉回到 100 附近可加碼）");
    expect(r.pullbackAdd).toBe(100);
    expect(r.holdingLabel).toBe("續抱（拉回到 100 附近可加碼）");
    expect(r.riskNote).toContain("高於支撐區上緣 100 約 10%");
    expect(`${r.label}${r.reason}`).not.toMatch(/現價不買|等回到|等回檔/);
    expect(isRecommendable(r)).toBe(true);
  });

  it("貼近上緣但有 RSI 超買漲多警訊 → 仍建議買進，風險提示講出警訊", () => {
    const r = computeSiteRating({ ...facets(GOOD), signals: [sig("RSI 82 超買")], framework: frame(100.5, [95, 100]) });
    expect(r.code).toBe("buy");
    expect(r.riskNote).toContain("RSI 82 超買");
  });

  it("大盤偏弱（60 日報酬 < 5%）→ 結論不變，附弱市況提示；大盤強時不附", () => {
    const weak = computeSiteRating({ ...facets(GOOD), signals: [], framework: frame(100.5, [95, 100]), marketRet60Pct: 2.34 });
    expect(weak.code).toBe("buy");
    expect(weak.marketNote).toBe(
      "大盤偏弱提示：近60日加權報酬 +2.3%，歷史上此時技術強勢股常落後（之後 10～20 日平均落後同類股約 0.5～1%），宜降低部位或分批"
    );
    expect(weak.reason).toContain("大盤偏弱提示");
    const strong = computeSiteRating({ ...facets(GOOD), signals: [], framework: frame(100.5, [95, 100]), marketRet60Pct: 8 });
    expect(strong.marketNote).toBeNull();
    const avoid = computeSiteRating({ ...facets(["支持", "中性", "中性", "中性", "中性"]), signals: [], framework: frame(100.5, [95, 100]), marketRet60Pct: -3 });
    expect(avoid.marketNote).toBeNull();
  });

  it("支持面向不足 → 建議先不要買", () => {
    const r = computeSiteRating({ ...facets(["支持", "中性", "中性", "中性", "中性"]), signals: [], framework: frame(100.5, [95, 100]) });
    expect(r.code).toBe("avoid");
    expect(r.label).toBe("建議先不要買");
    expect(r.holdingLabel).toBe("續抱觀察、不加碼");
    expect(isRecommendable(r)).toBe(false);
  });

  it("不支持 ≥2 → 先不要買、持有減碼", () => {
    const r = computeSiteRating({ ...facets(["支持", "不支持", "支持", "支持", "不支持"]), signals: [], framework: frame(100.5, [95, 100]) });
    expect(r.code).toBe("avoid");
    expect(r.holdingCode).toBe("reduce");
  });

  it("籌碼面不支持（法人賣超）即使其他面向都支持 → 先不要買", () => {
    const r = computeSiteRating({ ...facets(["支持", "不支持", "支持", "支持", "支持"]), signals: [], framework: frame(100.5, [95, 100]) });
    expect(r.code).toBe("avoid");
    expect(r.reason).toContain("法人賣超");
  });

  it("體質過門檻但破底（沒有支撐、不給區間）→ 先不要買、持有出場，理由附站回價位", () => {
    const r = computeSiteRating({ ...facets(GOOD), signals: [], framework: frame(80, null) });
    expect(r.code).toBe("avoid");
    expect(r.holdingCode).toBe("exit");
    expect(r.reason).toContain("站回 84");
  });

  it("日K不足（沒有價位框架）但體質過門檻 → 建議買進，理由註明未算出區間", () => {
    const r = computeSiteRating({ ...facets(GOOD), signals: [], framework: null });
    expect(r.code).toBe("buy");
    expect(r.reason).toContain("未算出參考價位");
    expect(r.zone).toBeNull();
  });

  it("新評等不會再產生等回檔（二分：建議買進／先不要買）", () => {
    for (const price of [96, 100.5, 110, 150]) {
      for (const signals of [[], [sig("RSI 82 超買")], [sig("MACD黃金交叉"), sig("KD黃金交叉")]]) {
        const r = computeSiteRating({ ...facets(GOOD), signals, framework: frame(price, [95, 100]) });
        expect(["buy", "avoid"]).toContain(r.code);
      }
    }
  });

  it("同樣輸入結果完全相同（純函式、無隨機）", () => {
    const input = { ...facets(GOOD), signals: [], framework: frame(110, [95, 100]) };
    expect(computeSiteRating(input)).toEqual(computeSiteRating(input));
  });

  it("describeSiteRating：先不要買不給任何價位，只給改判建議買進的條件", () => {
    const r = computeSiteRating({ ...facets(["不支持", "支持", "支持", "中性", "中性"]), signals: [], framework: frame(110, [95, 100]) });
    expect(r.code).toBe("avoid");
    const text = describeSiteRating("仁寶", "2324", r);
    expect(text).not.toMatch(/95|買進區間|跌破|出場 ?\d/);
    expect(text).toContain("改判建議買進的條件：技術面轉為支持");
    expect(r.upgradeCondition).toContain("技術面轉為支持");
  });

  it("describeSiteRating 帶標題、未持有／已持有字樣與價位", () => {
    const r = computeSiteRating({ ...facets(GOOD), signals: [], framework: frame(110, [95, 100], 90, 113.5) });
    const text = describeSiteRating("健鼎", "3044", r);
    expect(text.startsWith(SITE_RATING_TITLE)).toBe(true);
    expect(text).toContain("未持有：「建議買進（現價 110 可分批買；若拉回到 100 附近可加碼）」");
    expect(text).toContain("已持有：「續抱（拉回到 100 附近可加碼）」");
    expect(text).toContain("拉回加碼參考價 100");
    expect(text).not.toContain("不追價");
    expect(text).toContain("買進後跌破 90 出場");
  });
});

describe("stripRatingTags", () => {
  it("拿掉 AI 照抄的「未持有：」「已持有：」標籤，只留評等字樣", () => {
    expect(stripRatingTags("台光電(2383)：未持有：「建議等回檔再買（區間 5,220～5,645）」")).toBe("台光電(2383)：建議等回檔再買（區間 5,220～5,645）");
    expect(stripRatingTags("已持有：「續抱」，理由…")).toBe("續抱，理由…");
    expect(stripRatingTags("沒有標籤的句子")).toBe("沒有標籤的句子");
    expect(stripRatingTags("未持有：建議等回檔再買（區間 106.5～114.5）。\n- 走勢偏多")).toBe("建議等回檔再買（區間 106.5～114.5）。\n- 走勢偏多");
  });
});
