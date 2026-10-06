import { describe, expect, it } from "vitest";
import { CONFIDENCE_APPENDIX_TITLE, confidenceItemsFromGrounding, ensureConfidenceMentioned } from "@/lib/ai/confidenceMention";
import { CARD_CONFIDENCE_PREFIX, DECISION_CARD_TITLE } from "@/lib/ai/decisionCard";
import { WATCH_SUMMARY_TITLE } from "@/lib/ai/holdingRating";

const CONF = "本站把握程度：中（大盤不偏弱、今天剛轉為建議買進；回測：高＞中＞低，非勝率保證）";
const ratingLine = (name: string, sym: string, withConf = true) =>
  `【本站綜合評等】${name}(${sym})：未持有：「建議買進」／已持有：「續抱」。理由：支持面向 3/5。${withConf ? `${CONF}。` : ""}`;

const cardGrounding = `${DECISION_CARD_TITLE}台表科(6278)\n- 第一句（照抄）：台表科(6278)建議買進\n${CARD_CONFIDENCE_PREFIX}${CONF}\n- 價位：（無）\n\n${ratingLine("台表科", "6278")}`;

describe("ensureConfidenceMentioned（回答沒講把握程度就補程式判定）", () => {
  it("結論卡有把握程度行、回答提到該檔卻沒講：補一行", () => {
    const r = ensureConfidenceMentioned("台表科(6278)建議買進，技術面強勢。", cardGrounding);
    expect(r.appended).toEqual(["6278"]);
    expect(r.text).toContain(`${CONFIDENCE_APPENDIX_TITLE}：\n- 台表科(6278)：${CONF}`);
  });
  it("結論句後面是句號：直接插在結論句後面（跟今日建議卡同一個讀法），不另附一段", () => {
    const r = ensureConfidenceMentioned("台表科(6278)建議買進（現價 234 可分批買）。技術面強勢。", cardGrounding);
    expect(r.text).toBe(`台表科(6278)建議買進（現價 234 可分批買）。${CONF}。技術面強勢。`);
    expect(r.text).not.toContain(CONFIDENCE_APPENDIX_TITLE);
  });
  it("結論句沒有句號但後面是換行：補句號後插入；多檔各插各的", () => {
    const g = `${ratingLine("啟碁", "6285")}\n${ratingLine("華通", "2313")}\n${WATCH_SUMMARY_TITLE}啟碁(6285)「建議買進」（本站把握程度：中）、華通(2313)「建議買進」（本站把握程度：中）。每一檔都要寫到、不可漏掉。`;
    const a = "啟碁(6285)\n建議買進（現價 256）\n技術面強。\n\n華通(2313)\n建議買進。\n基本面佳。";
    const r = ensureConfidenceMentioned(a, g);
    expect(r.text).toBe(`啟碁(6285)\n建議買進（現價 256）。${CONF}。\n技術面強。\n\n華通(2313)\n建議買進。${CONF}。\n基本面佳。`);
    expect(r.appended).toEqual(["6285", "2313"]);
  });
  it("回答已在該檔附近講了把握程度：不補", () => {
    const a = "台表科(6278)建議買進，本站把握程度為中，宜分批。";
    expect(ensureConfidenceMentioned(a, cardGrounding)).toEqual({ text: a, appended: [] });
  });
  it("沒提到該檔（答非所問）或沒有把握程度行（先不要買／已持有）：不補", () => {
    expect(ensureConfidenceMentioned("今天大盤上漲。", cardGrounding).appended).toEqual([]);
    const noConf = cardGrounding.replace(`${CARD_CONFIDENCE_PREFIX}${CONF}\n`, "");
    expect(ensureConfidenceMentioned("台表科(6278)建議買進。", noConf).appended).toEqual([]);
  });
  it("關注清單：只補【僅關注評等彙整】列出把握程度、且回答提到卻沒講的那幾檔", () => {
    const g = `${ratingLine("啟碁", "6285")}\n${ratingLine("華通", "2313")}\n${ratingLine("友達", "2409")}\n${WATCH_SUMMARY_TITLE}啟碁(6285)「建議買進」（本站把握程度：中）、華通(2313)「建議買進」（本站把握程度：中）。每一檔都要寫到、不可漏掉。`;
    const a = "啟碁(6285)建議買進，本站把握程度：中。\n華通(2313)建議買進，技術面強。\n友達(2409)續抱。";
    const r = ensureConfidenceMentioned(a, g);
    expect(r.appended).toEqual(["2313"]);
    expect(confidenceItemsFromGrounding(g).map((x) => x.symbol).sort()).toEqual(["2313", "6285"]);
  });
  it("沒有相關區塊的參考資料完全不動", () => {
    const a = "台積電(2330)建議先不要買。";
    expect(ensureConfidenceMentioned(a, ratingLine("台積電", "2330"))).toEqual({ text: a, appended: [] });
  });
});
