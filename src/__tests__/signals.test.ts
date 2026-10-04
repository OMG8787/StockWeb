import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/data/types";
import { ema, computeMacdLines, MACD_MIN_BARS } from "@/lib/ema";
import { computeIndicatorState, computeKd } from "@/lib/signals";
import { computeMacdSeries } from "@/lib/indicators";

/** 固定、可重現的合成K線：close 由 closeAt(i) 決定，high/low 各上下 1。 */
function makeCandles(n: number, closeAt: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = closeAt(i);
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    return { time: d.toISOString().slice(0, 10), open: close, high: close + 1, low: close - 1, close, volume: 1000 };
  });
}

/** 擺盪的價格（週期約 30 根）：MACD／KD 會反覆黃金／死亡交叉。 */
const wave = (i: number) => 100 + 20 * Math.sin(i / 4.77) + i * 0.05;

describe("ema（SMA 種子）", () => {
  it("線性數列的 EMA3：種子＝前3根平均，之後套遞迴", () => {
    const out = ema([1, 2, 3, 4, 5, 6], 3);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBeCloseTo(2, 10);
    expect(out[3]).toBeCloseTo(3, 10); // 4*0.5 + 2*0.5
    expect(out[4]).toBeCloseTo(4, 10);
    expect(out[5]).toBeCloseTo(5, 10);
  });

  it("根數不足 period 全部回 null", () => {
    expect(ema([1, 2], 3)).toEqual([null, null]);
  });

  it("開頭帶 null（訊號線情形）從第一個有值處起算種子", () => {
    const out = ema([null, null, 1, 2, 3, 4], 3);
    expect(out.slice(0, 4)).toEqual([null, null, null, null]);
    expect(out[4]).toBeCloseTo(2, 10);
    expect(out[5]).toBeCloseTo(3, 10);
  });

  it("computeMacdLines：MACD 線前 25 根、訊號線前 33 根為 null", () => {
    const closes = makeCandles(80, wave).map((c) => c.close);
    const { macdLine, signalLine } = computeMacdLines(closes);
    expect(macdLine.findIndex((v) => v != null)).toBe(25);
    expect(signalLine.findIndex((v) => v != null)).toBe(33);
  });
});

describe("computeIndicatorState：MACD 交叉", () => {
  it("K線根數不足 MACD_MIN_BARS → macdCross／macdAboveZero 為 null", () => {
    const state = computeIndicatorState(makeCandles(MACD_MIN_BARS - 1, wave), 100);
    expect(state?.macdCross).toBeNull();
    expect(state?.macdAboveZero).toBeNull();
  });

  it("單調上升：沒有交叉、MACD 在 0 軸上方", () => {
    const candles = makeCandles(80, (i) => 100 + i);
    const state = computeIndicatorState(candles, candles[79].close);
    expect(state?.macdCross).toBeNull();
    expect(state?.macdAboveZero).toBe(true);
  });

  it("單調下降：沒有交叉、MACD 在 0 軸下方", () => {
    const candles = makeCandles(80, (i) => 300 - i);
    const state = computeIndicatorState(candles, candles[79].close);
    expect(state?.macdCross).toBeNull();
    expect(state?.macdAboveZero).toBe(false);
  });

  it("擺盪行情：黃金／死亡交叉的判定跟獨立重算的 MACD 與訊號線大小關係一致，且兩種都會出現", () => {
    const all = makeCandles(160, wave);
    let golden = 0;
    let death = 0;
    for (let n = MACD_MIN_BARS; n <= all.length; n++) {
      const sub = all.slice(0, n);
      const state = computeIndicatorState(sub, sub[n - 1].close);
      const { macdLine, signalLine } = computeMacdLines(sub.map((c) => c.close));
      const last = n - 1;
      const [pm, ps, m, s] = [macdLine[last - 1]!, signalLine[last - 1]!, macdLine[last]!, signalLine[last]!];
      const expected = pm <= ps && m > s ? "golden" : pm >= ps && m < s ? "death" : null;
      expect(state?.macdCross).toBe(expected);
      expect(state?.macdAboveZero).toBe(m >= 0);
      if (expected === "golden") golden++;
      if (expected === "death") death++;
    }
    expect(golden).toBeGreaterThan(0);
    expect(death).toBeGreaterThan(0);
  });

  it("圖表 MACD 副圖數列與訊號用同一份計算：最後一點 = computeMacdLines 最後一個值", () => {
    const candles = makeCandles(100, wave);
    const series = computeMacdSeries(candles);
    const { macdLine, signalLine } = computeMacdLines(candles.map((c) => c.close));
    expect(series.macd.at(-1)?.value).toBe(macdLine[99]);
    expect(series.signal.at(-1)?.value).toBe(signalLine[99]);
    expect(series.histogram.at(-1)?.value).toBe(macdLine[99]! - signalLine[99]!);
    expect(computeMacdSeries(candles.slice(0, MACD_MIN_BARS - 1))).toEqual({ macd: [], signal: [], histogram: [] });
  });
});

describe("computeKd：KD 交叉", () => {
  it("根數不足（< 15）回 null", () => {
    expect(computeKd(makeCandles(14, wave))).toBeNull();
    expect(computeKd(makeCandles(15, wave))).not.toBeNull();
  });

  it("單調上升：K、D 都在高檔、區間＝high、沒有交叉", () => {
    const candles = makeCandles(40, (i) => 100 + i);
    const kd = computeKd(candles);
    expect(kd?.cross).toBeNull();
    expect(kd?.zone).toBe("high");
    expect(kd!.k).toBeGreaterThan(70);
  });

  it("單調下降：區間＝low", () => {
    const kd = computeKd(makeCandles(40, (i) => 300 - i));
    expect(kd?.zone).toBe("low");
  });

  it("擺盪行情：cross 與 K／D 前後關係一致，黃金與死亡交叉都會出現", () => {
    const all = makeCandles(160, wave);
    let golden = 0;
    let death = 0;
    for (let n = 15; n <= all.length; n++) {
      const kd = computeKd(all.slice(0, n))!;
      const expected =
        kd.prevK <= kd.prevD && kd.k > kd.d ? "golden" : kd.prevK >= kd.prevD && kd.k < kd.d ? "death" : null;
      expect(kd.cross).toBe(expected);
      if (kd.cross === "golden") golden++;
      if (kd.cross === "death") death++;
    }
    expect(golden).toBeGreaterThan(0);
    expect(death).toBeGreaterThan(0);
  });

  it("computeIndicatorState 的 kd 就是 computeKd 的結果", () => {
    const candles = makeCandles(90, wave);
    expect(computeIndicatorState(candles, candles[89].close)?.kd).toEqual(computeKd(candles));
  });
});
