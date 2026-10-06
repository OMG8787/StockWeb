import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/data/types";
import { computeKdSeries } from "@/lib/indicators";
import { currentKdMethod, kdFromRsv, withKdMethod } from "@/lib/kdFormula";
import { computeKd } from "@/lib/signals";

function makeCandles(n: number, closeAt: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = closeAt(i);
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    return { time: d.toISOString().slice(0, 10), open: close, high: close + 1, low: close - 1, close, volume: 1000 };
  });
}
const wave = (i: number) => 100 + 20 * Math.sin(i / 4.77) + i * 0.05;

describe("KD 算法參數：sma（現行預設）／recursive（券商遞迴）", () => {
  it("遞迴版對照手算：RSV 80,60,40,100、初值 50 → K 60,60,53.333,68.889、D 53.333,55.556,54.815,59.506", () => {
    const { k, d } = kdFromRsv([80, 60, 40, 100], "recursive");
    [60, 60, 53.3333, 68.8889].forEach((v, i) => expect(k[i]).toBeCloseTo(v, 3));
    [53.3333, 55.5556, 54.8148, 59.5062].forEach((v, i) => expect(d[i]).toBeCloseTo(v, 3));
  });

  it("sma 版對照手算：RSV 80,60,40,100,20 → K 60,66.667,53.333；D 59.999…＝60", () => {
    const { k, d } = kdFromRsv([80, 60, 40, 100, 20], "sma");
    expect(k).toEqual([60, 200 / 3, 160 / 3]);
    expect(d[0]).toBeCloseTo((60 + 200 / 3 + 160 / 3) / 3, 10);
    expect(d).toHaveLength(1);
  });

  it("預設不變：computeKd／computeKdSeries 不傳參數＝sma，且與明確指定 sma 逐值相同", () => {
    const candles = makeCandles(120, wave);
    for (let n = 15; n <= candles.length; n++) {
      expect(computeKd(candles.slice(0, n))).toEqual(computeKd(candles.slice(0, n), "sma"));
    }
    expect(computeKdSeries(candles)).toEqual(computeKdSeries(candles, "sma"));
    expect(currentKdMethod()).toBe("sma");
  });

  it("computeKd(recursive) 對照獨立遞迴實作（從第 9 根起、初值 50）", () => {
    const candles = makeCandles(80, wave);
    let k = 50, d = 50;
    candles.forEach((c, i) => {
      if (i < 8) return;
      const w = candles.slice(i - 8, i + 1);
      const hh = Math.max(...w.map((x) => x.high)), ll = Math.min(...w.map((x) => x.low));
      const rsv = ((c.close - ll) / (hh - ll)) * 100;
      k = (2 / 3) * k + rsv / 3;
      d = (2 / 3) * d + k / 3;
    });
    const kd = computeKd(candles, "recursive")!;
    expect(kd.k).toBeCloseTo(k, 9);
    expect(kd.d).toBeCloseTo(d, 9);
    const s = computeKdSeries(candles, "recursive");
    expect(s.k.at(-1)!.value).toBeCloseTo(k, 9);
    expect(s.d.at(-1)!.value).toBeCloseTo(d, 9);
    expect(s.j.at(-1)!.value).toBeCloseTo(3 * k - 2 * d, 9);
    expect(s.k[0].time).toBe(candles[8].time);
  });

  it("withKdMethod 只在執行期間切換、結束（含例外）一律還原", () => {
    const candles = makeCandles(60, wave);
    const viaScope = withKdMethod("recursive", () => computeKd(candles));
    expect(viaScope).toEqual(computeKd(candles, "recursive"));
    expect(viaScope).not.toEqual(computeKd(candles));
    expect(currentKdMethod()).toBe("sma");
    expect(() => withKdMethod("recursive", () => { throw new Error("x"); })).toThrow();
    expect(currentKdMethod()).toBe("sma");
  });
});
