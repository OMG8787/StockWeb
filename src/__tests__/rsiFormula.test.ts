import { describe, expect, it } from "vitest";
import { latestRsi, rsiSeries, withRsiMethod, RSI_DEFAULT_METHOD } from "@/lib/rsiFormula";
import { computeRsiSeries } from "@/lib/indicators";
import { computeIndicatorState } from "@/lib/signals";
import type { Candle } from "@/lib/data/types";

const candles = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), open: c, high: c, low: c, close: c, volume: 1000 }));

// （參考）6278 台表科 10/6：Wilder 73.4（242 根）、簡單平均 83.0，見 docs/backtest/2026-10-rsi-formula.md
const WAVE = Array.from({ length: 80 }, (_, i) => 100 + 15 * Math.sin(i / 3.1) + i * 0.1);

describe("rsiFormula", () => {
  it("預設是 Wilder", () => {
    expect(RSI_DEFAULT_METHOD).toBe("wilder");
  });
  it("StockCharts 教科書範例收盤：第 14 個變動 RSI ≈ 70.5、下一根 ≈ 66.3", () => {
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
    const r = rsiSeries(closes, 14, "wilder");
    expect(r[13]).toBeNull();
    expect(r[14]).toBeCloseTo(70.5, 0);
    expect(r[15]).toBeCloseTo(66.3, 0);
  });
  it("簡單平均版＝最近 14 個變動的漲跌總和（舊行為）", () => {
    const closes = WAVE;
    const simple = rsiSeries(closes, 14, "simple");
    let g = 0, l = 0;
    for (let j = closes.length - 14; j < closes.length; j++) {
      const ch = closes[j] - closes[j - 1];
      if (ch > 0) g += ch; else l -= ch;
    }
    expect(simple[closes.length - 1]).toBeCloseTo(100 - 100 / (1 + g / l), 10);
  });
  it("全漲＝100、全平＝null、根數不足＝null", () => {
    expect(latestRsi(Array.from({ length: 20 }, (_, i) => 100 + i), 14, "wilder")).toBe(100);
    expect(latestRsi(Array.from({ length: 20 }, () => 100), 14, "wilder")).toBeNull();
    expect(latestRsi([1, 2, 3], 14)).toBeNull();
  });
  it("Wilder 比簡單平均平滑：連漲後簡單版衝得更高", () => {
    const closes = [...Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? -1 : 1)), 102, 104, 106, 108, 110, 112];
    expect(latestRsi(closes, 14, "simple")!).toBeGreaterThan(latestRsi(closes, 14, "wilder")!);
  });
  it("全站同一個來源：signals 指標狀態、圖表序列、直接計算三者相同；withRsiMethod 暫時切換後會還原", () => {
    const cs = candles(WAVE);
    const direct = latestRsi(WAVE, 14)!;
    expect(computeIndicatorState(cs, cs.at(-1)!.close)!.rsi).toBeCloseTo(direct, 10);
    expect(computeRsiSeries(cs).at(-1)!.value).toBeCloseTo(direct, 10);
    const simple = withRsiMethod("simple", () => computeIndicatorState(cs, cs.at(-1)!.close)!.rsi!);
    expect(simple).not.toBeCloseTo(direct, 3);
    expect(computeIndicatorState(cs, cs.at(-1)!.close)!.rsi).toBeCloseTo(direct, 10);
  });
});
