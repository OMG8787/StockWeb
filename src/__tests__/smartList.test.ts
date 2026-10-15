import { describe, expect, it } from "vitest";
import {
  canStillPass,
  daysUntilRemoval,
  dueSmartSlot,
  EMPTY_SMART_DATA,
  failingConditions,
  mergeSmartRun,
  normalizeSmartConfig,
  SMART_KEEP_DAYS,
} from "@/lib/strategy/smartListCore";
import { DEFAULT_STRATEGY_CONFIG, type IndicatorHit, type StrategyConfig } from "@/lib/strategy/engine";

const tpe = (day: string, hm: string) => new Date(`${day}T${hm}:00+08:00`);
const hit = (id: string, pass: boolean | null): IndicatorHit => ({ id, name: `條件${id}`, pass, detail: "" });
const rules: StrategyConfig = { ...DEFAULT_STRATEGY_CONFIG, buy: { ids: ["a", "b", "c"], match: 0 }, sell: { ids: [], match: 1 } };

describe("我的智能清單", () => {
  it("設定整理：策略最多 3 個、時間格式、預設兩個時間", () => {
    expect(normalizeSmartConfig({ enabled: true, strategyIds: ["x", "y", "z", "w"], times: ["13:40", "9:00", "25:00", "09:30"] }, new Set(["x", "y", "z", "w"]))).toEqual({
      enabled: true,
      strategyIds: ["x", "y", "z"],
      times: ["09:30", "13:40"],
    });
    expect(normalizeSmartConfig({ strategyIds: ["gone"] }, new Set(["x"]))).toMatchObject({ enabled: false, strategyIds: [], times: ["10:00", "13:40"] });
  });

  it("不成立的條件：條件式列出沒成立的（資料不足註明）、計分式列總分與沒成立的正權重", () => {
    expect(failingConditions(rules, [hit("a", true), hit("b", false), hit("c", null)], 1)).toEqual(["條件b", "條件c（資料不足）"]);
    const score: StrategyConfig = { ...rules, mode: "score", weights: { a: 2, b: 1, c: -1 }, buyScore: 3 };
    expect(failingConditions(score, [hit("a", true), hit("b", false), hit("c", true)], 1)).toEqual(["總分 1 未達 3", "條件b"]);
  });

  it("還有沒有可能符合：貴的條件（評等）當作未知", () => {
    expect(canStillPass(rules, [hit("a", true), hit("b", false), hit("c", null)], new Set(["c"]))).toBe(false);
    expect(canStillPass(rules, [hit("a", true), hit("b", true), hit("c", null)], new Set(["c"]))).toBe(true);
    const atLeast2 = { ...rules, buy: { ids: ["a", "b", "c"], match: 2 } };
    expect(canStillPass(atLeast2, [hit("a", true), hit("b", false), hit("c", null)], new Set(["c"]))).toBe(true);
    const score: StrategyConfig = { ...rules, mode: "score", weights: { a: 1, c: 2 }, buyScore: 3 };
    expect(canStillPass(score, [hit("a", true)], new Set(["c"]))).toBe(true);
    expect(canStillPass(score, [hit("a", false)], new Set(["c"]))).toBe(false);
  });

  it("合併：新符合加入、不符合保留並註明、7 天沒再符合移除、沒檢查到的不動", () => {
    const d0 = tpe("2026-10-15", "10:00");
    let r = mergeSmartRun(EMPTY_SMART_DATA, [
      { symbol: "2330", name: "台積電", price: 1000, passed: ["策略A"], failing: [] },
      { symbol: "2317", name: "鴻海", price: 200, passed: [], failing: ["條件x"] },
    ], { now: d0, slot: "10:00", slotKey: "2026-10-15|10:00" });
    expect(r.added).toBe(1);
    expect(r.data.entries.map((e) => e.symbol)).toEqual(["2330"]);

    // 隔天不符合：保留、註明
    r = mergeSmartRun(r.data, [{ symbol: "2330", name: "台積電", price: 990, passed: [], failing: ["策略A：KD 黃金交叉"] }], {
      now: tpe("2026-10-16", "10:00"),
      slot: "10:00",
      slotKey: "2026-10-16|10:00",
    });
    const e = r.data.entries[0];
    expect(e).toMatchObject({ qualified: false, failing: ["策略A：KD 黃金交叉"], addedPrice: 1000, lastPrice: 990 });
    expect(daysUntilRemoval(e, tpe("2026-10-16", "10:00"))).toBe(SMART_KEEP_DAYS - 1);

    // 這次沒檢查到（evals 沒有它）→ 不動
    r = mergeSmartRun(r.data, [], { now: tpe("2026-10-20", "10:00"), slot: "10:00", slotKey: "2026-10-20|10:00" });
    expect(r.data.entries).toHaveLength(1);

    // 超過 7 天仍不符合 → 移除
    r = mergeSmartRun(r.data, [{ symbol: "2330", name: "台積電", price: 980, passed: [], failing: ["x"] }], {
      now: tpe("2026-10-23", "10:01"),
      slot: "10:00",
      slotKey: "2026-10-23|10:00",
    });
    expect(r.removed).toBe(1);
    expect(r.data.entries).toHaveLength(0);
    expect(r.data.runs[0]).toMatchObject({ removed: 1, slotKey: "2026-10-23|10:00" });
  });

  it("排程：週一～五、時間到了且在補跑期限內、同一時間只跑一次", () => {
    const times = ["10:00", "13:40"];
    expect(dueSmartSlot(times, tpe("2026-10-15", "09:59"), new Set())).toBeNull();
    expect(dueSmartSlot(times, tpe("2026-10-15", "10:03"), new Set())).toEqual({ slot: "10:00", slotKey: "2026-10-15|10:00" });
    expect(dueSmartSlot(times, tpe("2026-10-15", "10:03"), new Set(["2026-10-15|10:00"]))).toBeNull();
    expect(dueSmartSlot(times, tpe("2026-10-15", "13:45"), new Set(["2026-10-15|10:00"]))).toEqual({ slot: "13:40", slotKey: "2026-10-15|13:40" });
    expect(dueSmartSlot(times, tpe("2026-10-15", "16:30"), new Set(["2026-10-15|10:00"]))).toBeNull(); // 超過補跑期限
    expect(dueSmartSlot(times, tpe("2026-10-17", "10:05"), new Set())).toBeNull(); // 週六
  });
});
