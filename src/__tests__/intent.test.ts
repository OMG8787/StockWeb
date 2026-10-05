import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn } from "@/lib/ai/types";

// resolveFollowupTargets 只有在「接續追問」的觸發條件成立時才會去解析上文的股票；
// 解析股票名稱要打資料層（宇宙快取），測試不碰網路，所以把它換成假的。
const guessSymbolsFromText = vi.fn(async (text: string) =>
  text.includes("AAA")
    ? [
        { symbol: "2330", market: "TW" as const },
        { symbol: "2454", market: "TW" as const },
        { symbol: "3034", market: "TW" as const },
      ]
    : []
);
vi.mock("@/lib/ai/symbolResolve", () => ({
  guessSymbolsFromText: (text: string) => guessSymbolsFromText(text),
}));

import {
  conversationWantsMovers,
  conversationWantsTechScreen,
  detectHistoryPeriod,
  HISTORY_PERIOD_MAX_DAYS,
  isBareTradeYesNoQuestion,
  isListReferenceQuestion,
  resolveFollowupTargets,
  resolveListReferenceTargets,
  wantsMarketWideBuyIdea,
} from "@/lib/ai/intent";

// 2026-10-04 是週日；10/3 週六；10/7 週三
const SUNDAY = { year: 2026, month: 10, day: 4 };
const SATURDAY = { year: 2026, month: 10, day: 3 };
const WEDNESDAY = { year: 2026, month: 10, day: 7 };

describe("detectHistoryPeriod", () => {
  it("週日問「上週」＝剛結束的交易週（週一～週五），不是更早一週", () => {
    const p = detectHistoryPeriod("6488上週外資怎麼買", SUNDAY);
    expect(p).toMatchObject({ from: "2026-09-28", to: "2026-10-02" });
  });

  it("週六問「上週」同樣是剛結束的交易週", () => {
    const p = detectHistoryPeriod("上週外資怎麼買", SATURDAY);
    expect(p).toMatchObject({ from: "2026-09-28", to: "2026-10-02" });
  });

  it("平日（週三）問「上週」＝上一個日曆週（週一～週日）", () => {
    const p = detectHistoryPeriod("上週表現", WEDNESDAY);
    expect(p).toMatchObject({ from: "2026-09-28", to: "2026-10-04" });
  });

  it("昨天、前天", () => {
    expect(detectHistoryPeriod("昨天收多少", SUNDAY)).toMatchObject({ from: "2026-10-03", to: "2026-10-03" });
    expect(detectHistoryPeriod("前天收多少", SUNDAY)).toMatchObject({ from: "2026-10-02", to: "2026-10-02" });
  });

  it("單一明確日期：10月1日", () => {
    expect(detectHistoryPeriod("10月1日收盤多少", SUNDAY)).toMatchObject({ from: "2026-10-01", to: "2026-10-01" });
  });

  it("日期區間：9月22日到10月2日", () => {
    expect(detectHistoryPeriod("9月22日到10月2日外資買賣超", SUNDAY)).toMatchObject({
      from: "2026-09-22",
      to: "2026-10-02",
    });
  });

  it("沒寫年份的日期比今天晚就當成去年", () => {
    expect(detectHistoryPeriod("12月30日收盤", { year: 2026, month: 1, day: 5 })).toMatchObject({
      from: "2025-12-30",
      to: "2025-12-30",
    });
  });

  it("不合法日期（2月31日）不命中", () => {
    expect(detectHistoryPeriod("2月31日收盤", SUNDAY)).toBeUndefined();
  });

  it("近N天＝最近N個交易日，超過上限會截斷", () => {
    expect(detectHistoryPeriod("近10天走勢", SUNDAY)).toEqual({ label: "最近10個交易日", lastTradingDays: 10 });
    expect(detectHistoryPeriod("最近五天", SUNDAY)).toEqual({ label: "最近5個交易日", lastTradingDays: 5 });
    expect(detectHistoryPeriod("近三十天", SUNDAY)).toMatchObject({ lastTradingDays: HISTORY_PERIOD_MAX_DAYS });
  });

  it("「1/3」當分數時不誤判成 1 月 3 日", () => {
    expect(detectHistoryPeriod("我想用1/3的資金買台積電", SUNDAY)).toBeUndefined();
  });

  it("「1/3」在有明確行情語境時才當日期（那天收盤）", () => {
    expect(detectHistoryPeriod("1/3那天收盤多少", SUNDAY)).toMatchObject({ from: "2026-01-03", to: "2026-01-03" });
  });

  it("一般問題不命中", () => {
    expect(detectHistoryPeriod("台積電值得買嗎", SUNDAY)).toBeUndefined();
    expect(detectHistoryPeriod("上個月營收多少", SUNDAY)).toBeUndefined();
  });

  it("上個月、這個月", () => {
    expect(detectHistoryPeriod("上個月表現", SUNDAY)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(detectHistoryPeriod("這個月表現", SUNDAY)).toMatchObject({ from: "2026-10-01", to: "2026-10-04" });
  });
});

describe("resolveFollowupTargets 觸發條件", () => {
  const history: ChatTurn[] = [
    { role: "user", content: "今天強勢股" },
    { role: "assistant", content: "AAA 強勢股有三檔" },
  ];

  beforeEach(() => {
    guessSymbolsFromText.mockClear();
  });

  it("不是接續追問的句子直接回空，也不解析上文", async () => {
    expect(await resolveFollowupTargets("今天天氣很好吧我們出去走走", history)).toEqual([]);
    expect(guessSymbolsFromText).not.toHaveBeenCalled();
  });

  it("代名詞（這檔）→ 取上文第一檔", async () => {
    expect(await resolveFollowupTargets("這檔可以買嗎", history)).toEqual([{ symbol: "2330", market: "TW" }]);
  });

  it("序數（第二檔）→ 取上文第二檔", async () => {
    expect(await resolveFollowupTargets("第二檔的本益比多少", history)).toEqual([{ symbol: "2454", market: "TW" }]);
  });

  it("只丟指標名稱的短句觸發；含篩選字眼或太長則不觸發", async () => {
    expect(await resolveFollowupTargets("本益比多少?", history)).toHaveLength(1);
    expect(await resolveFollowupTargets("有沒有本益比低的", history)).toEqual([]);
    expect(await resolveFollowupTargets("本益比跟殖利率還有營收都一起列出來給我看看", history)).toEqual([]);
  });

  it("核對／時間類短句觸發（沒有代名詞也沒有指標名稱）", async () => {
    expect(await resolveFollowupTargets("那你現在查看看", history)).toHaveLength(1);
    expect(await resolveFollowupTargets("還是是昨天有，所以盤中你才說有？", history)).toHaveLength(1);
  });

  it("觸發了但對話裡沒有提過任何股票 → 空", async () => {
    expect(await resolveFollowupTargets("這檔可以買嗎", [{ role: "user", content: "你好" }])).toEqual([]);
    expect(await resolveFollowupTargets("這檔可以買嗎", [])).toEqual([]);
  });

  it("由新到舊找第一則有股票的訊息", async () => {
    const turns: ChatTurn[] = [
      { role: "assistant", content: "AAA" },
      { role: "user", content: "好的謝謝" },
    ];
    expect(await resolveFollowupTargets("這檔呢", turns)).toEqual([{ symbol: "2330", market: "TW" }]);
  });
});

// 2026-10-04 使用者回報：先問「2330 最近走勢如何？」再問「建議買嗎?」，AI 改推薦全市場其他股票。
describe("沒指名對象的買賣是非題 vs 全市場推薦", () => {
  beforeEach(() => {
    guessSymbolsFromText.mockClear();
  });

  it("是非題不算全市場推薦；要清單的問法才算", () => {
    for (const q of ["建議買嗎?", "建議買嗎", "可以買嗎", "要不要買", "值得買嗎？", "該賣嗎", "現在建議進場嗎"]) {
      expect(wantsMarketWideBuyIdea(q), q).toBe(false);
      expect(isBareTradeYesNoQuestion(q), q).toBe(true);
    }
    for (const q of ["建議買什麼", "下週開盤建議買入的股票。", "建議布局哪些標的", "有什麼可以買的", "建議挑幾檔買", "今天有什麼股票推薦買進？"]) {
      expect(wantsMarketWideBuyIdea(q), q).toBe(true);
      expect(isBareTradeYesNoQuestion(q), q).toBe(false);
    }
    expect(wantsMarketWideBuyIdea("我的關注清單裡建議買哪檔")).toBe(false);
    expect(isBareTradeYesNoQuestion("還有別的可以買嗎")).toBe(false);
    expect(isBareTradeYesNoQuestion("有沒有適合明天買的")).toBe(false);
  });

  it("追問「建議買嗎」→ 取使用者自己問過的那一檔，不取 AI 回答裡順帶提到的其他公司", async () => {
    guessSymbolsFromText.mockImplementation(async (text: string) =>
      text.includes("2330")
        ? [{ symbol: "2330", market: "TW" as const }]
        : text.includes("精材")
          ? [{ symbol: "3374", market: "TW" as const }, { symbol: "2330", market: "TW" as const }]
          : []
    );
    const history: ChatTurn[] = [
      { role: "user", content: "2330 最近走勢如何？" },
      { role: "assistant", content: "精材與台積電近期走勢偏強" },
    ];
    expect(await resolveFollowupTargets("建議買嗎?", history)).toEqual([{ symbol: "2330", market: "TW" }]);
    guessSymbolsFromText.mockImplementation(async (text: string) =>
      text.includes("AAA")
        ? [
            { symbol: "2330", market: "TW" as const },
            { symbol: "2454", market: "TW" as const },
          ]
        : []
    );
  });

  it("使用者沒講過個股、AI 剛列了好幾檔 → 不硬猜，回空（照原本流程）", async () => {
    const history: ChatTurn[] = [
      { role: "user", content: "今天強勢股" },
      { role: "assistant", content: "AAA 強勢股有三檔" },
    ];
    expect(await resolveFollowupTargets("可以買嗎", history)).toEqual([]);
    // 原本的全市場追問行為仍在（沒有個股可追問時）
    expect(conversationWantsMovers("可以買嗎", history)).toBe(true);
    expect(conversationWantsMovers("建議買什麼", [])).toBe(true);
  });
});

describe("conversationWantsTechScreen：快要／即將交叉的問法", () => {
  it("沒有找股動詞也接得住「快黃金交叉」這類說法", () => {
    for (const q of [
      "那有快黃金交叉的嗎?",
      "有快要KD黃金交叉的股票嗎",
      "即將交叉的有哪些",
      "快金叉的呢",
      "快要死叉的",
      "接近MACD黃金交叉的股票",
    ]) {
      expect(conversationWantsTechScreen(q, []), q).toBe(true);
    }
  });

  it("短追問：上一句問過快要交叉，接「那死亡交叉呢」「美股呢」仍附清單", () => {
    const history: ChatTurn[] = [
      { role: "user", content: "那有快黃金交叉的嗎?" },
      { role: "assistant", content: "……" },
    ];
    expect(conversationWantsTechScreen("美股呢", history)).toBe(true);
  });

  it("純名詞解釋不觸發", () => {
    expect(conversationWantsTechScreen("黃金交叉是什麼意思", [])).toBe(false);
  });
});

describe("「這幾檔／這些」指代上一則回答的整份清單（2026-10-05 使用者回報跑出清單外的台積電）", () => {
  beforeEach(() => {
    guessSymbolsFromText.mockImplementation(async (text: string) =>
      text.includes("AAA")
        ? [
            { symbol: "2330", market: "TW" as const },
            { symbol: "2454", market: "TW" as const },
            { symbol: "3034", market: "TW" as const },
          ]
        : []
    );
  });
  it("isListReferenceQuestion 認得常見說法、不誤判一般問題", () => {
    for (const q of ["這幾檔有你特別看好的嗎?", "這些哪個比較好", "上面這些可以買嗎", "剛剛那幾檔哪檔最強", "名單裡有推薦的嗎"]) {
      expect(isListReferenceQuestion(q), q).toBe(true);
    }
    for (const q of ["台積電可以買嗎", "有推薦的股票嗎", "我的關注清單裡這些哪檔該賣"]) {
      expect(isListReferenceQuestion(q), q).toBe(false);
    }
  });

  it("resolveListReferenceTargets 回傳最近一則列了 2 檔以上的 AI 回答中的全部股票", async () => {
    const history: ChatTurn[] = [
      { role: "user", content: "快要黃金交叉的有哪些" },
      { role: "assistant", content: "AAA 清單" },
    ];
    const got = await resolveListReferenceTargets(history);
    expect(got.map((t) => t.symbol)).toEqual(["2330", "2454", "3034"]);
  });

  it("對話裡沒有列出股票的 AI 回答時回空陣列（走原本流程）", async () => {
    expect(await resolveListReferenceTargets([{ role: "assistant", content: "沒有股票" }])).toEqual([]);
  });
});
