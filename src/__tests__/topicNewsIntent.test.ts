import { describe, expect, it, vi } from "vitest";

// intent.ts 會 import symbolResolve（碰資料層），這個測試只測純函式，換成假的。
vi.mock("@/lib/ai/symbolResolve", () => ({ guessSymbolsFromText: async () => [] }));

import { extractTopicNewsQuery } from "@/lib/ai/intent";

describe("extractTopicNewsQuery 主題新聞意圖", () => {
  it.each([
    ["今天有沒有 美國 伊朗的新聞", "美國 伊朗"],
    ["最近 Fed 有什麼消息", "Fed"],
    ["俄烏戰爭最新情況", "俄烏戰爭"],
    ["有沒有川普的最新消息？", "川普"],
    ["最近輝達有什麼新聞嗎", "輝達"],
    ["伊朗新聞對台股有什麼影響", "伊朗"],
    ["台積電最新新聞", "台積電"],
    ["中東最近發生什麼事", "中東"],
    ["今天有沒有OPEC的報導", "OPEC"],
  ])("%s → %s", (q, topic) => {
    expect(extractTopicNewsQuery(q)).toBe(topic);
  });

  it.each([
    "今天有什麼新聞",
    "台股今天有什麼新聞",
    "最近市場有什麼消息",
    "有哪些新聞",
    "台積電可以買嗎",
    "MACD是什麼意思",
    "這則新聞對台積電有什麼影響",
    "今天大盤怎麼樣",
    "",
  ])("不是主題新聞題：%s", (q) => {
    expect(extractTopicNewsQuery(q)).toBeNull();
  });
});

import { formatTopicNewsBlock, normalizeTopicKey, TOPIC_NEWS_TITLE } from "@/lib/data/topicNews";
import { BLOCK_MARKERS, composeAskSystemPrompt } from "@/lib/ai/askSystemCompose";
import { RULE_TOPIC_NEWS } from "@/lib/ai/askSystemPrompt";

describe("主題新聞資料區塊", () => {
  const item = { title: "美國對伊朗金融制裁升級", source: "商傳媒", pubDate: "2026-10-05T20:00:00.000Z" };

  it("三種搜尋狀態文字明確可分（成功／0 則／失敗），標題用共用常數", () => {
    const ok = formatTopicNewsBlock({ topic: "美國 伊朗", days: 3, status: "ok", items: [item] });
    const empty = formatTopicNewsBlock({ topic: "美國 伊朗", days: 3, status: "empty", items: [] });
    const failed = formatTopicNewsBlock({ topic: "美國 伊朗", days: 3, status: "failed", items: [] });
    for (const t of [ok, empty, failed]) expect(t.startsWith(TOPIC_NEWS_TITLE)).toBe(true);
    expect(ok).toContain("搜尋成功，共 1 則");
    expect(ok).toContain("第1則［10-06］美國對伊朗金融制裁升級（商傳媒）"); // 台北時間日期；程式先編號，AI 逐則引用
    expect(empty).toContain("結果 0 則");
    expect(failed).toContain("搜尋失敗");
    expect(failed).not.toContain("0 則");
  });

  it("快取鍵正規化：大小寫與空白不同的同一主題共用", () => {
    expect(normalizeTopicKey("  Fed   利率 ")).toBe(normalizeTopicKey("fed 利率"));
  });

  it("有主題新聞區塊才帶 RULE_TOPIC_NEWS", () => {
    const base = {
      question: "q", lastUserTurn: "", hasHistory: false, stockText: "", stockCount: 0, holdingsText: "", holdingsMode: "none" as const,
      holdingsBackground: false, holdingsEmptyAsked: false, indexText: "", moversText: "", techScreenText: "", hasTheme: false,
      hasNotFoundMarker: false, singleStockDeep: false, marketWide: false, twMarketOpen: false, usMarketOpen: false,
    };
    const block = formatTopicNewsBlock({ topic: "Fed", days: 3, status: "ok", items: [item] });
    expect(composeAskSystemPrompt({ ...base, topicNewsText: block })).toContain(RULE_TOPIC_NEWS);
    expect(composeAskSystemPrompt(base)).not.toContain(RULE_TOPIC_NEWS);
    expect(BLOCK_MARKERS.topicNews).toBe(TOPIC_NEWS_TITLE);
  });
});
