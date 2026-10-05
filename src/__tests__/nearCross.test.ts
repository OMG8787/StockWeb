import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/data/types";
import {
  detectNearCross,
  KD_NEAR_CROSS_CONVERGING_DAYS,
  KD_NEAR_CROSS_MAX_EST_DAYS,
  KD_NEAR_CROSS_MAX_GAP,
} from "@/lib/nearCross";
import { computeIndicatorState, computeKd } from "@/lib/signals";

const KD_OPTS = {
  convergingDays: KD_NEAR_CROSS_CONVERGING_DAYS,
  maxEstDays: KD_NEAR_CROSS_MAX_EST_DAYS,
  maxGap: KD_NEAR_CROSS_MAX_GAP,
  requireFastMoving: true,
};

describe("detectNearCross：序列層級", () => {
  it("剛好即將黃金交叉：K<D、差距 6→4→2 連續縮小、K 上升 → golden，推估約 1 天", () => {
    const r = detectNearCross([30, 34, 38], [36, 38, 40], KD_OPTS);
    expect(r?.direction).toBe("golden");
    expect(r?.gaps).toEqual([6, 4, 2]);
    expect(r?.estDays).toBeCloseTo(1, 10);
    expect(r?.fast).toBe(38);
    expect(r?.slow).toBe(40);
  });

  it("剛好即將死亡交叉：K>D、差距縮小、K 下降 → death", () => {
    const r = detectNearCross([80, 76, 72], [74, 72, 70], KD_OPTS);
    expect(r?.direction).toBe("death");
    expect(r?.gaps).toEqual([6, 4, 2]);
  });

  it("今天已經交叉（K 已上穿 D）→ 不算即將交叉", () => {
    expect(detectNearCross([30, 34, 41], [36, 38, 40], KD_OPTS)).toBeNull();
  });

  it("視窗內前幾天已交叉過（不是一直在同一側）→ null", () => {
    expect(detectNearCross([40, 34, 38], [36, 38, 40], KD_OPTS)).toBeNull();
  });

  it("差距大於門檻 → null（即使在收斂）", () => {
    // 差距 20→14→8：收斂中、外推 8/6≈1.3 天，但 8 > KD_NEAR_CROSS_MAX_GAP
    expect(detectNearCross([20, 26, 32], [40, 40, 40], KD_OPTS)).toBeNull();
  });

  it("差距雖小但沒有連續縮小 → null", () => {
    expect(detectNearCross([36, 35, 38], [40, 40, 40], KD_OPTS)).toBeNull(); // 4→5→2
  });

  it("收斂太慢（外推超過門檻天數）→ null", () => {
    // 差距 4.4→4.2→4.0，每天只縮 0.2，外推 20 天
    expect(detectNearCross([35.6, 35.8, 36], [40, 40, 40], KD_OPTS)).toBeNull();
  });

  it("要求快線朝交叉方向移動：K 沒升、只是 D 自己往下靠 → null", () => {
    expect(detectNearCross([30, 30, 30], [36, 34, 32], KD_OPTS)).toBeNull();
    // 不要求時同一組資料則成立
    expect(detectNearCross([30, 30, 30], [36, 34, 32], { ...KD_OPTS, requireFastMoving: false })?.direction).toBe(
      "golden"
    );
  });

  it("視窗內有 null 或根數不足 → null", () => {
    expect(detectNearCross([null, 34, 38], [36, 38, 40], KD_OPTS)).toBeNull();
    expect(detectNearCross([34, 38], [38, 40], KD_OPTS)).toBeNull();
  });
});

/** 固定、可重現的合成K線：close 由 closeAt(i) 決定，high/low 各上下 1。 */
function makeCandles(n: number, closeAt: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = closeAt(i);
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    return { time: d.toISOString().slice(0, 10), open: close, high: close + 1, low: close - 1, close, volume: 1000 };
  });
}
// 主週期＋短週期疊加的擺盪：KD 在轉折前會「K 已回頭、D 還在追」，才有即將交叉的樣態
// （單純大振幅正弦會讓 KD 在 0/100 附近飽和、K 幾乎不動，測不到）。
const wave = (i: number) => 100 + 6 * Math.sin(i / 7) + 3 * Math.cos(i / 2.7);

describe("computeIndicatorState：用合成K線逐日掃描即將交叉", () => {
  const all = makeCandles(200, wave);
  const states = Array.from({ length: all.length - 60 }, (_, j) => {
    const sub = all.slice(0, 60 + j);
    return { sub, state: computeIndicatorState(sub, sub[sub.length - 1].close)! };
  });

  it("擺盪行情中 KD、MACD 的即將黃金／死亡交叉都至少出現一次", () => {
    const has = (pick: (s: (typeof states)[number]["state"]) => string | undefined, dir: string) =>
      states.some(({ state }) => pick(state) === dir);
    expect(has((s) => s.kdNearCross?.direction, "golden")).toBe(true);
    expect(has((s) => s.kdNearCross?.direction, "death")).toBe(true);
    expect(has((s) => s.macdNearCross?.direction, "golden")).toBe(true);
    expect(has((s) => s.macdNearCross?.direction, "death")).toBe(true);
  });

  it("判定為即將交叉的那天：今天一定還沒交叉，且數值吻合 K<D（黃金）／K>D（死亡）", () => {
    for (const { sub, state } of states) {
      const near = state.kdNearCross;
      if (near) {
        expect(state.kd?.cross).toBeNull();
        const kd = computeKd(sub)!;
        expect(near.fast).toBeCloseTo(kd.k, 10);
        expect(near.slow).toBeCloseTo(kd.d, 10);
        if (near.direction === "golden") expect(kd.k).toBeLessThan(kd.d);
        else expect(kd.k).toBeGreaterThan(kd.d);
        expect(near.gaps[near.gaps.length - 1]).toBeLessThanOrEqual(KD_NEAR_CROSS_MAX_GAP);
      }
      if (state.macdNearCross) expect(state.macdCross).toBeNull();
    }
  });

  it("單調上升（K 長期在 D 上方、MACD 柱狀體擴大）→ 不會誤判即將交叉", () => {
    const up = makeCandles(80, (i) => 100 + i * 1.5);
    const state = computeIndicatorState(up, up[79].close)!;
    expect(state.kdNearCross).toBeNull();
    expect(state.macdNearCross).toBeNull();
  });
});
