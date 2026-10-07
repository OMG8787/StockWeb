import { describe, expect, it, vi } from "vitest";
import type { Candle } from "@/lib/data/types";

// grounding/indicators.ts 也 import 了資料層（getChart），測試只用純函式，換成空殼避免載入網路／快取模組。
vi.mock("@/lib/data", () => ({ getChart: vi.fn() }));

import { describeRecentCrosses } from "@/lib/ai/grounding/indicators";
import { computeIndicatorState } from "@/lib/signals";

function makeCandles(n: number, closeAt: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = closeAt(i);
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    return { time: d.toISOString().slice(0, 10), open: close, high: close + 1, low: close - 1, close, volume: 1000 };
  });
}
// 每一天以「；」分隔，但最後一段的說明文字本身也含「；」，所以只在後面接日期時才切。
const DAY_SEPARATOR = /；(?=\d{4}-\d{2}-\d{2})/;
const wave =(i: number) => 100 + 20 * Math.sin(i / 4.77) + i * 0.05;

describe("describeRecentCrosses", () => {
  it("單調上升：近5天都沒有交叉，共 5 段，最後一段標最新交易日", () => {
    const candles = makeCandles(80, (i) => 100 + i);
    const parts = describeRecentCrosses(candles, false).split(DAY_SEPARATOR);
    expect(parts).toHaveLength(5);
    expect(parts.every((p) => p.endsWith("沒有交叉"))).toBe(true);
    expect(parts[4]).toContain(candles[79].time);
    expect(parts[4]).toContain("最新一個交易日");
  });

  it("盤中：最後一天標「今天，盤中仍會變動」", () => {
    const candles = makeCandles(80, (i) => 100 + i);
    expect(describeRecentCrosses(candles, true)).toContain(`${candles[79].time}（今天，盤中仍會變動）`);
  });

  it("擺盪行情：每一天的交叉描述跟逐日截斷K線算出的指標狀態一致", () => {
    const all = makeCandles(160, wave);
    let sawCross = false;
    for (let n = 60; n <= all.length; n++) {
      const candles = all.slice(0, n);
      const parts = describeRecentCrosses(candles, false).split(DAY_SEPARATOR);
      expect(parts).toHaveLength(5);
      parts.forEach((part, idx) => {
        const back = 4 - idx;
        const upTo = candles.slice(0, n - back);
        const last = upTo[upTo.length - 1];
        const state = computeIndicatorState(upTo, last.close)!;
        const expected: string[] = [];
        if (state.macdCross === "golden") expected.push("MACD黃金交叉");
        if (state.macdCross === "death") expected.push("MACD死亡交叉");
        if (state.kd?.cross === "golden") expected.push("KD黃金交叉");
        if (state.kd?.cross === "death") expected.push("KD死亡交叉");
        const tail = part.slice(part.indexOf("：") + 1);
        expect(tail).toBe(expected.length > 0 ? expected.join("＋") : "沒有交叉");
        if (expected.length > 0) sawCross = true;
      });
    }
    expect(sawCross).toBe(true);
  });

  it("K線太少（指標算不出來）→ 空字串", () => {
    expect(describeRecentCrosses(makeCandles(3, () => 100), false)).toBe("");
  });
});

describe("describeRecentCrosses：最後一根不是今天（盤中日K不含今天，2026-10-07 宏璟）", () => {
  it("盤中但最後一根是昨天 → 標「最近一個已收盤的交易日」、不說今天盤中", () => {
    const candles = makeCandles(80, (i) => 100 + i);
    const out = describeRecentCrosses(candles, true, "2099-01-01");
    expect(out).toContain("最近一個已收盤的交易日");
    expect(out).not.toContain("（今天，盤中仍會變動）");
  });
  it("盤中且最後一根就是今天 → 維持原標示", () => {
    const candles = makeCandles(80, (i) => 100 + i);
    expect(describeRecentCrosses(candles, true, candles[79].time)).toContain("（今天，盤中仍會變動）");
  });
});
