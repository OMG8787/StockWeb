import { describe, expect, it } from "vitest";
import {
  answerCardIssues,
  describeDecisionCard,
  pickForComparison,
  renderCardFallback,
  looksTruncated,
  COMPARISON_PICK_TITLE,
  ensureFuzzyConfirmation,
} from "@/lib/ai/decisionCard";
import { finalizeAiAnswer } from "@/lib/ai/ask";
import type { SiteRating } from "@/lib/ai/siteRating";
import type { Facet } from "@/lib/ai/actionScoring";
import { stripNameMarker, stripNameMarkersInText, plainTwName } from "@/lib/ai/fuzzyName";
import { composeAskSystemPrompt, type AskPromptContext } from "@/lib/ai/askSystemCompose";
import { RULE_NO_UNVERIFIABLE_CONFESSION } from "@/lib/ai/askSystemPrompt";
import { getTradingStance } from "@/lib/ai/tradingStance";

function rating(over: Partial<SiteRating>): SiteRating {
  return {
    code: "buy",
    label: "建議買進（現價 557 可分批買；若拉回到 534 附近可加碼）",
    holdingCode: "hold",
    holdingLabel: "續抱（拉回到 534 附近可加碼）",
    reason: "支持面向 3/5",
    supportCount: 3,
    againstCount: 1,
    zone: { low: 520, high: 534 },
    noChase: null,
    exit: 500,
    chaseHits: [],
    riskNote: null,
    pullbackAdd: 534,
    marketNote: null,
    upgradeCondition: null,
    ...over,
  };
}
const facets: Facet[] = [
  { name: "技術面", verdict: "支持", detail: "站上20日均線、MACD黃金交叉" },
  { name: "財報面", verdict: "支持", detail: "8月營收年增 +53.3%" },
  { name: "籌碼面", verdict: "不支持", detail: "外資賣超 1,200 張" },
];
const buyCard = describeDecisionCard({ name: "國巨*", symbol: "2327", rating: rating({}), facets, held: false });
const avoidCard = describeDecisionCard({
  name: "聯電",
  symbol: "2303",
  rating: rating({ code: "avoid", label: "建議先不要買", pullbackAdd: null, exit: null, upgradeCondition: "三大法人轉為買超" }),
  facets,
  held: false,
});

describe("結論卡", () => {
  it("第一句、價位、面向、風險都來自評等；名稱去掉星號", () => {
    expect(buyCard).toContain("國巨(2327)");
    expect(buyCard).not.toContain("國巨*");
    expect(buyCard).toContain("- 第一句（照抄）：國巨(2327)建議買進（現價 557 可分批買；若拉回到 534 附近可加碼）");
    expect(buyCard).toContain("拉回加碼參考價 534");
    expect(buyCard).toContain("買進後跌破 500 出場");
    expect(buyCard).toContain("技術面：站上20日均線");
    expect(buyCard).toContain("- 主要風險：籌碼面：外資賣超 1,200 張");
  });
  it("先不要買不給任何買進／出場價位，只給改判條件", () => {
    expect(avoidCard).toContain("- 第一句（照抄）：聯電(2303)建議先不要買");
    expect(avoidCard).toContain("改判建議買進的條件：三大法人轉為買超");
    expect(avoidCard).not.toMatch(/出場|加碼參考價/);
  });
  it("已持有用 holdingLabel、不印新買進者的出場價", () => {
    const held = describeDecisionCard({ name: "國巨", symbol: "2327", rating: rating({}), facets, held: true });
    expect(held).toContain("- 第一句（照抄）：國巨(2327)續抱（拉回到 534 附近可加碼）");
    expect(held).not.toContain("買進後跌破");
  });
});

describe("回答後檢查", () => {
  it("第一句沒有結論字樣、建議買進寫等回檔、截斷都會被抓到", () => {
    expect(answerCardIssues("建議買進，現價可分批買。理由一。", buyCard)).toEqual([]);
    expect(answerCardIssues("你是指國巨(2327)嗎？以下以國巨回答。建議買進，現價可分批買。", buyCard)).toEqual([]);
    expect(answerCardIssues("目前走勢偏多。技術面不錯。建議買進。", buyCard)[0]).toContain("第一句必須照抄");
    expect(answerCardIssues("建議買進。但現價不買，等回檔再說。", buyCard).join()).toContain("要等或觀望的字眼");
    expect(answerCardIssues("先不要買，因為法人賣超。", avoidCard)).toEqual([]);
    expect(answerCardIssues("建議買進。理由是營收成長很強，法人連續買超，而且外資", buyCard).join()).toContain("沒有寫完");
    // 非判斷題不附結論卡，就不檢查第一句
    expect(answerCardIssues("台積電昨天沒有KD黃金交叉。", "【本站綜合評等】台積電(2330)：…")).toEqual([]);
  });
  it("截斷判斷：句尾標點、數字單位不算截斷", () => {
    expect(looksTruncated("這是一段完整的回答，結尾有句號。")).toBe(false);
    expect(looksTruncated("出場價是 500 元")).toBe(false);
    expect(looksTruncated("這是一段沒有寫完的回答，理由是營收成長很強而且法人")).toBe(true);
  });
  it("重生通過就用重生版；仍不過就用程式版（第一句一定是評等）", async () => {
    const regenerated = await finalizeAiAnswer({
      raw: "走勢偏多。技術面不錯。建議買進。",
      grounding: buyCard,
      regenerate: async () => "建議買進（現價 557 可分批買；若拉回到 534 附近可加碼）。理由：營收年增 53%。",
    });
    expect(regenerated.outcome).toBe("regenerated");
    const program = await finalizeAiAnswer({
      raw: "走勢偏多。技術面不錯。建議買進。",
      grounding: buyCard,
      regenerate: async () => "還是先觀望。",
    });
    expect(program.outcome).toBe("program");
    expect(program.answer.startsWith("國巨(2327)建議買進（現價 557")).toBe(true);
    expect(renderCardFallback(buyCard)).toContain("主要風險：籌碼面：外資賣超 1,200 張。");
  });
});

describe("多檔與錯字", () => {
  it("比較題每檔都要講到自己的結論，漏講的會被抓到；程式版列出每檔", () => {
    const both = `${buyCard}\n${avoidCard}\n${COMPARISON_PICK_TITLE}若只能選一檔，選國巨(2327)。原因：…`;
    expect(answerCardIssues("若只能選一檔選國巨(2327)，建議買進。聯電(2303)建議先不要買。", both)).toEqual([]);
    expect(answerCardIssues("若只能選一檔選國巨(2327)，建議買進。聯電技術面也不錯。", both).join()).toContain("聯電(2303)建議先不要買");
    const fb = renderCardFallback(both) ?? "";
    expect(fb.split("\n")[0]).toBe("若只能選一檔，選國巨(2327)。");
    expect(fb).toContain("聯電(2303)建議先不要買。");
  });
  it("錯字近似：回答沒有確認句時程式補在最前面", () => {
    const g = "回答第一句必須寫「你是指健鼎(3044)嗎？以下以健鼎回答」，接著…";
    expect(ensureFuzzyConfirmation("建議買進。", g)).toBe("你是指健鼎(3044)嗎？以下以健鼎回答。\n建議買進。");
    expect(ensureFuzzyConfirmation("你是指健鼎(3044)嗎？建議買進。", g)).toBe("你是指健鼎(3044)嗎？建議買進。");
    expect(ensureFuzzyConfirmation("建議買進。", "")).toBe("建議買進。");
  });
});

describe("比較題程式結論", () => {
  it("建議買進優先；同評等比支持減不支持；同分取先出現的", () => {
    const a = { name: "台光電", symbol: "2383", rating: rating({ code: "avoid", label: "建議先不要買", supportCount: 2, againstCount: 2 }) };
    const b = { name: "健鼎", symbol: "3044", rating: rating({ supportCount: 3, againstCount: 1 }) };
    expect(pickForComparison([a, b])).toContain("若只能選一檔，選健鼎(3044)");
    const c = { ...b, symbol: "2330", name: "台積電", rating: rating({ supportCount: 4, againstCount: 0 }) };
    expect(pickForComparison([b, c])).toContain("選台積電(2330)");
    expect(pickForComparison([b, { ...b, symbol: "2317", name: "鴻海" }])).toContain("選健鼎(3044)");
    expect(pickForComparison([b])).toBeNull();
    expect(pickForComparison([a, { ...a, symbol: "3044", name: "健鼎" }])).toContain(COMPARISON_PICK_TITLE);
  });
});

describe("名稱標記", () => {
  it("星號去掉、KY 保留（錯字比對才去 KY）、回答裡的 名稱*(代號) 修正但不動粗體", () => {
    expect(stripNameMarker("國巨*")).toBe("國巨");
    expect(stripNameMarker("康控-KY")).toBe("康控-KY");
    expect(plainTwName("康控-KY")).toBe("康控");
    expect(stripNameMarkersInText("國巨*(2327)建議買進")).toBe("國巨(2327)建議買進");
    expect(stripNameMarkersInText("**國巨**(2327)")).toBe("**國巨**(2327)");
  });
});

describe("提示詞組裝與時段立場", () => {
  const base: AskPromptContext = {
    question: "建鼎呢?",
    lastUserTurn: "台光電可以買嗎？",
    hasHistory: true,
    stockText: "",
    stockCount: 0,
    holdingsText: "",
    holdingsMode: "none",
    holdingsBackground: false,
    holdingsEmptyAsked: false,
    indexText: "",
    moversText: "",
    techScreenText: "",
    hasTheme: false,
    hasNotFoundMarker: false,
    singleStockDeep: false,
    marketWide: false,
    twMarketOpen: false,
    usMarketOpen: false,
  };
  it("「看不到更早紀錄」規則只在使用者引用先前說法時組入（有對話紀錄不夠）", () => {
    expect(composeAskSystemPrompt(base)).not.toContain(RULE_NO_UNVERIFIABLE_CONFESSION);
    expect(composeAskSystemPrompt({ ...base, question: "白天你不是說不要追高南亞" })).toContain(RULE_NO_UNVERIFIABLE_CONFESSION);
  });
  it("盤後定價立場依二分評等，不拿收盤價比區間", () => {
    const line = getTradingStance(new Date("2026-10-05T14:00:00+08:00")).stanceLine;
    expect(line).toContain("盤後定價可以用今天收盤價分批買");
    expect(line).not.toContain("收盤價不在買進區間");
  });
});

describe("死亡交叉說明（2026-10-07 宏璟：出現死亡交叉真的還可以買嗎）", () => {
  const sig = (label: string, tone: "up" | "down") => ({ label, tone });
  const tech = (isToday: boolean) => ({
    signals: [sig("KD死亡交叉（K值下穿D值，發生在高檔）", "down"), sig("站上20日均線", "up"), sig("均線多頭排列（5日線在10日線）", "up")],
    lastCandleDate: "2026-10-06",
    lastIsToday: isToday,
  });
  const base = { name: "宏璟", symbol: "2527", rating: rating({}), facets: [{ name: "技術面", verdict: "中性", detail: "x" }] as Facet[], held: false };
  it("有死叉：卡片寫出哪個死叉、哪一天已收盤確認、技術面判定與回測依據", () => {
    const card = describeDecisionCard({ ...base, tech: tech(false) });
    expect(card).toContain("死亡交叉說明（程式）");
    expect(card).toContain("KD死亡交叉");
    expect(card).toContain("10/06（已收盤確認）");
    expect(card).toContain("技術面判定「中性」");
    expect(card).toContain("沒有統計上顯著較差");
  });
  it("最後一根是今天（盤中）：標盤中、收盤前可能消失", () => {
    expect(describeDecisionCard({ ...base, tech: tech(true) })).toContain("今天，盤中看到");
  });
  it("沒有死叉或結論是先不要買：不寫", () => {
    expect(describeDecisionCard({ ...base, tech: { signals: [sig("站上20日均線", "up")], lastCandleDate: "2026-10-06", lastIsToday: false } })).not.toContain("死亡交叉說明");
    expect(describeDecisionCard({ ...base, rating: rating({ code: "avoid" }), tech: tech(false) })).not.toContain("死亡交叉說明");
  });
});
