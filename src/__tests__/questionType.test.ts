import { describe, expect, it } from "vitest";
import { classifyQuestion, detectScreenConcepts } from "@/lib/ai/questionType";
import { findUngroundedPrices, stripUngroundedPriceSentences } from "@/lib/ai/numberGuard";
import { computeConceptStats } from "@/lib/data/conceptScreen";
import { pickConceptStocks } from "@/lib/ai/grounding/conceptScreen";

const cls = (question: string, namedStockCount = 0, hasHoldings = false) => classifyQuestion({ question, namedStockCount, hasHoldings });

describe("classifyQuestion（2026-10-07 開放題根因）", () => {
  it("台指期／大盤漲跌看法 → market-outlook，不沿用上文個股、不可套個股判斷", () => {
    for (const q of ["你覺得今天台指期收盤會漲還是跌", "明天台股會漲嗎？", "今天台股為什麼跌？", "那大盤現在怎麼樣？", "Fed 降息對台股有什麼影響？", "台指期夜盤現在多少？"]) {
      const c = cls(q);
      expect(c.type, q).toBe("market-outlook");
      expect(c.useContextStock, q).toBe(false);
      expect(c.allowStockJudgment, q).toBe(false);
    }
  });
  it("概念篩選 → screen-concept＋概念", () => {
    const c = cls("有看起來抗壓性強且有上漲趨勢的股票嗎?");
    expect(c.type).toBe("screen-concept");
    expect(c.concepts).toEqual(["resilient", "uptrend"]);
    expect(c.useContextStock).toBe(false);
    expect(cls("有低波動、高殖利率的股票嗎？").concepts).toEqual(["lowVol", "highYield"]);
    expect(cls("最近有哪些股票是多頭趨勢、站上季線的？").type).toBe("screen-concept");
  });
  it("名詞／常識 → general-knowledge", () => {
    for (const q of ["本益比是什麼？怎麼看高低？", "殖利率是什麼意思？", "ETF 跟個股差在哪？新手適合哪一種？", "大盤震盪的時候適合買什麼類型的股票？"]) {
      expect(cls(q).type, q).toBe("general-knowledge");
    }
  });
  it("點名或指代個股、名單指代、技術指標篩選、一般推薦 → other（沿用原路由）", () => {
    expect(cls("台積電明天會漲嗎", 1).type).toBe("other");
    expect(cls("這檔抗壓性強嗎").type).toBe("other");
    expect(cls("這些股票哪檔抗壓性比較強?").type).toBe("other");
    expect(cls("有沒有MACD與KD都黃金交叉且多頭排列的股票").type).toBe("other");
    expect(cls("明天盤中建議買入哪些股票?").type).toBe("other");
    expect(cls("建議買嗎?").type).toBe("other");
    expect(cls("台股有哪些股票明天會漲").type).toBe("other");
    expect(cls("那美股呢?").type).toBe("other");
  });
  it("方法題與持股分析", () => {
    expect(cls("你怎麼判斷是要放著還是認賠出場?").type).toBe("method");
    expect(cls("分析我的關注清單", 0, true).type).toBe("holdings");
  });
  it("detectScreenConcepts", () => {
    expect(detectScreenConcepts("高股息又抗跌")).toEqual(["resilient", "highYield"]);
    expect(detectScreenConcepts("今天天氣")).toEqual([]);
  });
});

describe("findUngroundedPrices（編造股價防線）", () => {
  const g = "台積電(2330) 現價 2565（+1.2%）\n加權指數：49822.55（+0.22%）\n夜盤最新價50116點 三大法人買超783.1億";
  it("抓出參考資料沒有的價格與不在資料裡的個股價格", () => {
    const a = "今日開盤可分批買入：台積電參考價約600元，跌破580元停損；台光電(2383) 120元。";
    const found = findUngroundedPrices(a, g);
    expect(found.map((f) => f.raw)).toEqual(["600", "580", "120"]);
    expect(found[2].reason).toBe("stock-not-in-grounding");
  });
  it("四捨五入、資料裡的指數點數、漲跌變動量、百分比與張數不算", () => {
    const a = "台積電(2330)現價約2,570元，漲了30元；加權指數收在49822點，夜盤50116點；法人買超783.1億、成交5000張、漲幅1.2%。";
    expect(findUngroundedPrices(a, g)).toEqual([]);
  });
  it("刪掉有問題的句子", () => {
    const a = "我覺得偏多。台積電參考價約600元。加權指數收在49822點。";
    const out = stripUngroundedPriceSentences(a, findUngroundedPrices(a, g));
    expect(out).not.toContain("600");
    expect(out).toContain("49822");
  });
});

describe("概念篩選（純函式）", () => {
  it("上漲趨勢與抗跌統計", () => {
    const days = Array.from({ length: 62 }, (_, i) => i);
    const dates = days.map((i) => new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10));
    const candles = days.map((i) => ({ time: dates[i], open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i + (i % 2 ? -0.2 : 0), volume: 1 }));
    const taiex = new Map(dates.slice(1).map((d, i) => [d, i % 2 ? -1 : 0.5]));
    const s = computeConceptStats({ symbol: "1111", name: "測試", price: 161, changePercent: 1, turnover: 1 }, candles, taiex);
    expect(s.ma20Rising).toBe(true);
    expect(s.ma60).not.toBeNull();
    expect(s.downDayExcess).toBeGreaterThan(0);
    expect(s.maxDrawdown60).toBeLessThan(1);
    const weak = computeConceptStats({ symbol: "2222", name: "弱", price: 80, changePercent: -1, turnover: 1 }, candles.map((c, i) => ({ ...c, close: 160 - i })), taiex);
    const picked = pickConceptStocks([s, weak], ["uptrend"]);
    expect(picked.full.map((x) => x.symbol)).toEqual(["1111"]);
  });
});
