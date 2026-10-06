import { describe, expect, it } from "vitest";
import { FACTS_APPENDIX_TITLE, ensureStockFactsMentioned, stockFactsFromGrounding } from "@/lib/ai/stockFactsMention";
import { CARD_CONFIDENCE_PREFIX, DECISION_CARD_TITLE } from "@/lib/ai/decisionCard";
import { WATCH_SUMMARY_TITLE } from "@/lib/ai/holdingRating";
import { describeLiveQuoteLine } from "@/lib/ai/livePrice";

const CONF = "本站把握程度：中（大盤不偏弱、今天剛轉為建議買進；回測：高＞中＞低，非勝率保證）";
const q = (price: number, pct: number) => ({ price, changePercent: pct, tradeTime: "2026-10-06T05:31:00.000Z" });
const NOW = new Date("2026-10-06T06:00:00.000Z");
const live = (name: string, sym: string, price: number, pct: number, ratingPrice?: number) => describeLiveQuoteLine(name, sym, q(price, pct), ratingPrice, NOW);
const ratingLine = (name: string, sym: string, unheld = "建議買進", withConf = true) =>
  `【本站綜合評等】${name}(${sym})：未持有：「${unheld}（現價 234 可分批買）」／已持有：「續抱」。理由：支持面向 3/5。${withConf ? `${CONF}。` : ""}`;

const PRICE = "現價 234（+6.4%，13:31）";
const cardGrounding = `${DECISION_CARD_TITLE}台表科(6278)\n- 第一句（照抄）：台表科(6278)建議買進\n${CARD_CONFIDENCE_PREFIX}${CONF}\n- 價位：（無）\n\n${live("台表科", "6278", 234, 6.4)}\n${ratingLine("台表科", "6278")}`;

describe("livePrice 格式", () => {
  it("今天只寫 HH:MM、評等價不同時註明", () => {
    expect(live("台表科", "6278", 234, 6.4)).toBe(`【即時報價】台表科(6278)：${PRICE}`);
    expect(live("台表科", "6278", 236, -1.25, 234)).toBe("【即時報價】台表科(6278)：現價 236（-1.25%，13:31；評等以 234 計算）");
  });
});

describe("ensureStockFactsMentioned（回答沒講現價／把握程度就由程式補）", () => {
  it("結論句後是句號：直接插在結論句後面（現價→把握程度），不另附一段", () => {
    const r = ensureStockFactsMentioned("台表科(6278)建議買進（現價 234 可分批買）。技術面強勢。", cardGrounding);
    expect(r.text).toBe(`台表科(6278)建議買進（現價 234 可分批買）。${PRICE}。${CONF}。技術面強勢。`);
    expect(r.appended).toEqual(["6278"]);
  });
  it("回答已寫了這個現價片段、也講了把握程度：不動", () => {
    const a = `台表科(6278)建議買進。${PRICE}。本站把握程度為中。`;
    expect(ensureStockFactsMentioned(a, cardGrounding)).toEqual({ text: a, appended: [] });
  });
  it("只缺現價：只補現價", () => {
    const r = ensureStockFactsMentioned("台表科(6278)建議買進。本站把握程度為中，宜分批。", cardGrounding);
    expect(r.text).toBe(`台表科(6278)建議買進。${PRICE}。本站把握程度為中，宜分批。`);
  });
  it("結論後面只有行尾空白（Markdown 換行）：插在空白前面", () => {
    const r = ensureStockFactsMentioned("台表科(6278)建議買進（現價 234 可分批買）  \n本站把握程度：中。技術面強。", cardGrounding);
    expect(r.text).toBe(`台表科(6278)建議買進（現價 234 可分批買）。${PRICE}。  \n本站把握程度：中。技術面強。`);
  });
  it("結論句還沒講完（後面是逗號）：附在最後", () => {
    const r = ensureStockFactsMentioned("台表科(6278)建議買進，技術面強勢。", cardGrounding);
    expect(r.text).toContain(`${FACTS_APPENDIX_TITLE}：\n- 台表科(6278)：${PRICE}；${CONF}`);
  });
  it("先不要買也要有現價、沒有把握程度", () => {
    const g = `${DECISION_CARD_TITLE}台積電(2330)\n- 第一句（照抄）：台積電(2330)建議先不要買\n\n${live("台積電", "2330", 2585, 0.5)}\n${ratingLine("台積電", "2330", "建議先不要買", false)}`;
    const r = ensureStockFactsMentioned("台積電(2330)建議先不要買。籌碼轉弱。", g);
    expect(r.text).toBe("台積電(2330)建議先不要買。現價 2,585（+0.5%，13:31）。籌碼轉弱。");
  });
  it("關注清單深度分析：每檔（含持有中）都補，各插各的結論句", () => {
    const g = [
      "股票：啟碁（6285，台股）\n狀態：僅關注，尚未持有",
      live("啟碁", "6285", 256, 1.2),
      ratingLine("啟碁", "6285"),
      live("友達", "2409", 15.5, -0.3),
      ratingLine("友達", "2409", "建議先不要買", false),
      `${WATCH_SUMMARY_TITLE}啟碁(6285)「建議買進」（本站把握程度：中）。每一檔都要寫到、不可漏掉。`,
    ].join("\n");
    const a = "啟碁(6285)\n建議買進（現價 256 可分批買）。技術面強。\n\n友達(2409)\n續抱。基本面差。";
    const r = ensureStockFactsMentioned(a, g);
    expect(r.text).toBe(
      `啟碁(6285)\n建議買進（現價 256 可分批買）。現價 256（+1.2%，13:31）。${CONF}。技術面強。\n\n友達(2409)\n續抱。現價 15.5（-0.3%，13:31）。基本面差。`
    );
  });
  it("沒有結論卡也不是關注清單深度分析（一般問答）：不補", () => {
    const g = `${live("台積電", "2330", 2585, 0.5)}\n${ratingLine("台積電", "2330")}`;
    const a = "台積電(2330)今天 EPS 是多少。";
    expect(ensureStockFactsMentioned(a, g)).toEqual({ text: a, appended: [] });
    expect(stockFactsFromGrounding(g)).toEqual([]);
  });
  it("答非所問沒提到該檔：不補", () => {
    expect(ensureStockFactsMentioned("今天大盤上漲。", cardGrounding).appended).toEqual([]);
  });
});
