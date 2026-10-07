import { describe, expect, it } from "vitest";
import type { TechScreenItem } from "@/lib/data";
import type { IndicatorState } from "@/lib/signals";
import {
  conditionsForQuestion,
  describeCondition,
  matchesAllConditions,
  parseIndicatorConditions,
  rankDualNearCross,
  wantsBuyRated,
} from "@/lib/ai/techScreenConditions";
import { conversationWantsTechScreen } from "@/lib/ai/intent";

function state(over: Partial<IndicatorState> = {}): IndicatorState {
  return {
    macdCross: null,
    macdAboveZero: true,
    kd: { k: 50, d: 55, prevK: 46, prevD: 54, cross: null, zone: "mid" },
    rsi: 65,
    maAlignment: null,
    aboveMa20: true,
    bollinger: null,
    streakDays: 0,
    streakDirection: null,
    volumeRatio: 1,
    macdReading: { dif: -0.4, signal: -0.2, prevDif: -0.6, prevSignal: -0.3 },
    kdNearCross: null,
    macdNearCross: null,
    ...over,
  };
}
const item = (symbol: string, s: IndicatorState): TechScreenItem => ({
  symbol,
  market: "TW",
  name: symbol,
  price: 100,
  changePercent: 1,
  turnover: 1,
  state: s,
  signals: [],
});

describe("parseIndicatorConditions", () => {
  it("使用者原句：RSI70以下", () => {
    expect(parseIndicatorConditions("那有rsi70以下建議買進的股票嗎")).toEqual([{ field: "rsi", op: "le", value: 70 }]);
  });
  it("低於／小於／<：嚴格小於", () => {
    expect(parseIndicatorConditions("RSI 低於 30")).toEqual([{ field: "rsi", op: "lt", value: 30 }]);
    expect(parseIndicatorConditions("RSI<30")).toEqual([{ field: "rsi", op: "lt", value: 30 }]);
  });
  it("高於／以上", () => {
    expect(parseIndicatorConditions("RSI 高於 75")).toEqual([{ field: "rsi", op: "gt", value: 75 }]);
    expect(parseIndicatorConditions("RSI在60以上")).toEqual([{ field: "rsi", op: "ge", value: 60 }]);
  });
  it("KD 低於 20 → K、D 兩條；K值單獨", () => {
    expect(parseIndicatorConditions("KD低於20的股票")).toEqual([
      { field: "k", op: "lt", value: 20 },
      { field: "d", op: "lt", value: 20 },
    ]);
    expect(parseIndicatorConditions("K值 30 以下")).toEqual([{ field: "k", op: "le", value: 30 }]);
  });
  it("多個條件", () => {
    expect(parseIndicatorConditions("RSI 70 以下而且 K值低於 50").length).toBe(2);
  });
  it("沒有數值條件 → 空", () => {
    expect(parseIndicatorConditions("RSI 是什麼意思")).toEqual([]);
    expect(parseIndicatorConditions("有沒有黃金交叉的股票")).toEqual([]);
  });
  it("describeCondition", () => {
    expect(describeCondition({ field: "rsi", op: "le", value: 70 })).toBe("RSI ≤ 70");
  });
});

describe("條件比對", () => {
  it("RSI 83 不符合 ≤70、65 符合；算不出來不符合", () => {
    const c = parseIndicatorConditions("RSI70以下");
    expect(matchesAllConditions(state({ rsi: 83 }), c)).toBe(false);
    expect(matchesAllConditions(state({ rsi: 65 }), c)).toBe(true);
    expect(matchesAllConditions(state({ rsi: 70 }), c)).toBe(true);
    expect(matchesAllConditions(state({ rsi: null }), c)).toBe(false);
  });
  it("KD 條件：kd 為 null 不符合", () => {
    expect(matchesAllConditions(state({ kd: null }), parseIndicatorConditions("K值低於50"))).toBe(false);
  });
});

describe("建議買進字眼與接續題", () => {
  it("wantsBuyRated", () => {
    expect(wantsBuyRated("那有rsi70以下建議買進的股票嗎")).toBe(true);
    expect(wantsBuyRated("RSI70以下的股票")).toBe(false);
  });
  it("接續題沿用上一問的數值條件", () => {
    const r = conditionsForQuestion("那建議買進的呢", "有沒有 RSI 低於 60 的股票");
    expect(r.conds).toEqual([{ field: "rsi", op: "lt", value: 60 }]);
    expect(r.rated).toBe(true);
  });
  it("這句自己有條件就不看上文", () => {
    const r = conditionsForQuestion("RSI 80 以上的有哪些", "有沒有 RSI 低於 60 的股票");
    expect(r.conds).toEqual([{ field: "rsi", op: "ge", value: 80 }]);
    expect(r.rated).toBe(false);
  });
});

describe("rankDualNearCross：MACD 與 KD 同時即將交叉", () => {
  const nearK = { direction: "golden" as const, fast: 49, slow: 50, gaps: [3, 2, 1], estDays: 1 };
  const nearM = { direction: "golden" as const, fast: -0.1, slow: -0.05, gaps: [0.2, 0.1, 0.05], estDays: 1 };
  it("兩者都符合門檻 → both", () => {
    const a = item("A", state({ kdNearCross: nearK, macdNearCross: nearM }));
    const { both, closest } = rankDualNearCross([a], "golden");
    expect(both.map((e) => e.item.symbol)).toEqual(["A"]);
    expect(closest).toEqual([]);
  });
  it("只有一邊符合門檻、另一邊也在縮小 → 列最接近；差距沒縮小或已交叉者不列", () => {
    const b = item("B", state({ kdNearCross: nearK })); // KD 差距 55-50=5、前 54-46=8 縮小；MACD gap 0.2 前 0.3 縮小
    const c = item("C", state({ macdReading: { dif: -0.4, signal: -0.2, prevDif: -0.3, prevSignal: -0.2 } })); // MACD 差距擴大
    const d = item("D", state({ kd: { k: 60, d: 55, prevK: 50, prevD: 54, cross: "golden", zone: "mid" } })); // KD 已交叉
    const { both, closest } = rankDualNearCross([b, c, d], "golden");
    expect(both).toEqual([]);
    expect(closest.map((e) => e.item.symbol)).toEqual(["B"]);
  });
  it("推估天數太遠者不列", () => {
    const e = item("E", state({ kd: { k: 20, d: 50, prevK: 19, prevD: 50, cross: null, zone: "low" } })); // gap 30 縮 1 → 30 天
    expect(rankDualNearCross([e], "golden").closest).toEqual([]);
  });
  it("死亡方向對稱", () => {
    const f = item("F", state({ kd: { k: 55, d: 50, prevK: 60, prevD: 50, cross: null, zone: "mid" }, macdReading: { dif: 0.4, signal: 0.2, prevDif: 0.6, prevSignal: 0.3 } }));
    expect(rankDualNearCross([f], "death").closest.map((x) => x.item.symbol)).toEqual(["F"]);
    expect(rankDualNearCross([f], "golden").closest).toEqual([]);
  });
});

describe("意圖：快線超過慢線的白話說法也走技術篩選", () => {
  it("使用者原句（無 KD／MACD 字樣）", () => {
    expect(conversationWantsTechScreen("那有兩種線快線都快超過慢線的嗎？", [])).toBe(true);
  });
  it("RSI 70 以下建議買進", () => {
    expect(conversationWantsTechScreen("那有rsi70以下建議買進的股票嗎", [])).toBe(true);
  });
});
