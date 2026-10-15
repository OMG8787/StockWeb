import { describe, expect, it } from "vitest";
import { MANUAL, MANUAL_BY_ID } from "@/lib/help/manual";
import { filterManual, queryTerms, searchManual } from "@/lib/help/search";

const top = (q: string) => searchManual(q, 3).map((s) => s.id);

describe("操作手冊搜尋", () => {
  it("手冊資料：id 不重複、每章有標題與內容、連結都是站內路徑", () => {
    expect(new Set(MANUAL.map((s) => s.id)).size).toBe(MANUAL.length);
    for (const s of MANUAL) {
      expect(s.title.length, s.id).toBeGreaterThan(3);
      expect(s.body.length, s.id).toBeGreaterThan(30);
      for (const l of s.links ?? []) expect(l.href.startsWith("/"), `${s.id}:${l.href}`).toBe(true);
    }
    expect(MANUAL_BY_ID.get("smart-list")?.body).toContain("300"); // 常數有帶進來
  });

  it("切詞：中文 2～4 字片段、英數字詞、去掉太泛的詞", () => {
    const t = queryTerms("怎麼設定智能清單？");
    expect(t).toContain("智能清單");
    expect(t).toContain("智能");
    expect(t).not.toContain("怎麼");
    expect(queryTerms("00406A 搜尋不到")).toContain("00406a");
  });

  it("常見問題找得到對的章節（前 3 名內）", () => {
    const cases: Array<[string, string]> = [
      ["怎麼設定智能清單", "smart-list"],
      ["智能清單多久更新一次", "smart-list"],
      ["我要怎麼回測一年", "backtest"],
      ["策略回測最大回撤是什麼", "backtest"],
      ["怎麼建立策略", "strategy-lib"],
      ["AI 策略可以自己改嗎", "strategy-lib"],
      ["推薦總覽是什麼", "overview-hub"],
      ["為什麼推薦股票的本站建議是不買", "who-decides"],
      ["買＊是什麼意思", "terms"],
      ["把握程度怎麼算", "terms"],
      ["推薦回顧的勝率怎麼算", "review"],
      ["怎麼設定提醒通知", "alerts"],
      ["怎麼加入關注清單", "home-watchlist"],
      ["AI 建議清單顯示幾檔", "home-watchlist"],
      ["搜尋不到 ETF 00406A", "stock-page"],
      ["模擬倉盤中交易時機", "sim"],
      ["AI 模擬組合持股比例", "portfolio"],
      ["怎麼改密碼", "account"],
      ["怎麼語音提問", "chat"],
      ["為什麼沒有資料", "limits"],
    ];
    for (const [q, id] of cases) expect(top(q), q).toContain(id);
  });

  it("完全無關的問題回空；手冊頁搜尋框找字或退回分詞搜尋", () => {
    expect(searchManual("今天晚餐吃什麼")).toEqual([]);
    expect(searchManual("")).toEqual([]);
    expect(filterManual("").length).toBe(MANUAL.length);
    expect(filterManual("多頭排列").map((s) => s.id)).toContain("indicators");
    expect(filterManual("智能清單怎麼用").map((s) => s.id)).toContain("smart-list");
  });
});
