import { describe, expect, it } from "vitest";
import { benchReturn, closeAfter, diffRecSymbols, followOutcome, horizonReturn, needsClose, recStats, returnCurve, REC_MAX_HOLD_DAYS, type RecEntry } from "@/lib/ai/recLedgerMath";

const days = (start: number, n: number) => Array.from({ length: n }, (_, i) => `2026-11-${String(start + i).padStart(2, "0")}`);

function entry(over: Partial<RecEntry> = {}): RecEntry {
  return { id: "x", source: "ai", symbol: "2330", name: "台積電", day: "2026-11-01", time: "10:00", at: "2026-11-01T02:00:00Z", price: 100, path: [], ...over };
}

describe("推薦紀錄計算", () => {
  it("第 N 個交易日收盤只算推薦日之後的（推薦當天收盤不算第 1 天）", () => {
    const e = entry({ path: [["2026-11-01", 101], ["2026-11-02", 103], ["2026-11-03", 98]] });
    expect(closeAfter(e, 1)).toBe(103);
    expect(closeAfter(e, 2)).toBe(98);
    expect(closeAfter(e, 3)).toBeNull();
    expect(horizonReturn(e, 1)).toBeCloseTo(3);
    expect(horizonReturn(e, 2)).toBeCloseTo(-2);
  });

  it("照建議操作：跌破出場價先出場", () => {
    const e = entry({ stop: 95, path: [["2026-11-02", 99], ["2026-11-03", 94], ["2026-11-04", 120]] });
    const o = followOutcome(e);
    expect(o.closed).toBe(true);
    expect(o.price).toBe(94);
    expect(o.pct).toBeCloseTo(-6);
    expect(o.reason).toContain("跌破出場價");
  });

  it("照建議操作：移出名單以移出價出場；當天就移出也算", () => {
    const e = entry({ exitDay: "2026-11-03", exitPrice: 108, exitReason: "移出 AI 建議名單", path: [["2026-11-02", 104], ["2026-11-03", 107]] });
    expect(followOutcome(e)).toMatchObject({ closed: true, price: 108, reason: "移出 AI 建議名單", heldDays: 2 });
    const same = entry({ exitDay: "2026-11-01", exitPrice: 97, path: [] });
    expect(followOutcome(same)).toMatchObject({ closed: true, price: 97, heldDays: 0 });
  });

  it("照建議操作：滿持有上限結算；沒出場就是持有中並用即時價", () => {
    const path = days(2, REC_MAX_HOLD_DAYS + 3).map((d, i) => [d, 100 + i] as [string, number]);
    const o = followOutcome(entry({ path }));
    expect(o.closed).toBe(true);
    expect(o.heldDays).toBe(REC_MAX_HOLD_DAYS);
    const open = followOutcome(entry({ path: [["2026-11-02", 102]] }), 110);
    expect(open).toMatchObject({ closed: false, price: 110, reason: "持有中" });
    expect(open.pct).toBeCloseTo(10);
  });

  it("同期 0050：推薦日收盤到第 N 天收盤", () => {
    const bench = { "2026-11-01": 200, "2026-11-02": 202, "2026-11-03": 198 };
    const e = entry({ path: [["2026-11-02", 103], ["2026-11-03", 98]] });
    expect(benchReturn(bench, e, 1)).toBeCloseTo(1);
    expect(benchReturn(bench, e, 2)).toBeCloseTo(-1);
    expect(benchReturn({}, e, 1)).toBeNull();
  });

  it("統計與曲線：只算已經走到那天的樣本", () => {
    const a = entry({ id: "a", path: [["2026-11-02", 110]], exitDay: "2026-11-02", exitPrice: 110 });
    const b = entry({ id: "b", symbol: "2317", price: 50, path: [["2026-11-02", 45], ["2026-11-03", 55]] });
    const s = recStats([a, b], {});
    expect(s.count).toBe(2);
    expect(s.closed).toBe(1);
    expect(s.winRate).toBe(100);
    expect(s.horizons[0]).toMatchObject({ h: 1, n: 2 });
    expect(s.horizons[0].avg).toBeCloseTo(0); // (+10% + -10%) / 2
    const curve = returnCurve([a, b], {}, 2);
    expect(curve[2]).toMatchObject({ day: 2, n: 1 });
    expect(curve[2].avg).toBeCloseTo(10);
  });

  it("名單比對與要不要補收盤價", () => {
    expect(diffRecSymbols(["2330", "2317"], ["2317", "2454"])).toEqual({ added: ["2454"], removed: ["2330"] });
    expect(diffRecSymbols(null, ["2330"])).toEqual({ added: ["2330"], removed: [] });
    const e = entry({ path: [["2026-11-02", 1]] });
    expect(needsClose(e, "2026-11-02")).toBe(false);
    expect(needsClose(e, "2026-11-03")).toBe(true);
    expect(needsClose(entry({ day: "2026-11-05" }), "2026-11-03")).toBe(false);
  });
});
