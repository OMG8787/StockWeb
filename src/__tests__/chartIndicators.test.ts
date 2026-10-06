import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/data/types";
import { computeKdSeries, computeMacdSeries, computeMaSeries, computeRsiSeries } from "@/lib/indicators";
import { INDICATOR_DEFS, trimIndicatorData } from "@/lib/chartIndicatorDefs";
import { CHART_WARMUP_RANGE } from "@/lib/data/chart";

function makeCandles(n: number, closeAt: (i: number) => number, startDay = 0): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = closeAt(i + startDay);
    const d = new Date(Date.UTC(2026, 0, 1 + i + startDay));
    return { time: d.toISOString().slice(0, 10), open: close, high: close + 1, low: close - 1, close, volume: 1000 };
  });
}
const wave = (i: number) => 100 + 20 * Math.sin(i / 4.77) + i * 0.05;

describe("KDJ（9,3,3）", () => {
  it("對照獨立暴力算法：K＝RSV 的3日均、D＝K 的3日均、J＝3K−2D", () => {
    const candles = makeCandles(60, wave);
    const rsv = candles.map((c, i) => {
      if (i < 8) return null;
      const w = candles.slice(i - 8, i + 1);
      const hh = Math.max(...w.map((x) => x.high));
      const ll = Math.min(...w.map((x) => x.low));
      return ((c.close - ll) / (hh - ll)) * 100;
    });
    const kRef = (i: number) => (rsv[i] != null && rsv[i - 1] != null && rsv[i - 2] != null ? (rsv[i]! + rsv[i - 1]! + rsv[i - 2]!) / 3 : null);
    const dRef = (i: number) => {
      const a = kRef(i), b = kRef(i - 1), c = kRef(i - 2);
      return a != null && b != null && c != null ? (a + b + c) / 3 : null;
    };
    const kd = computeKdSeries(candles);
    expect(kd.k.length).toBeGreaterThan(40);
    for (const p of kd.k) expect(p.value).toBeCloseTo(kRef(candles.findIndex((c) => c.time === p.time))!, 8);
    for (const p of kd.d) expect(p.value).toBeCloseTo(dRef(candles.findIndex((c) => c.time === p.time))!, 8);
    expect(kd.j.length).toBe(kd.d.length);
    for (const p of kd.j) {
      const k = kd.k.find((x) => x.time === p.time)!.value;
      const d = kd.d.find((x) => x.time === p.time)!.value;
      expect(p.value).toBeCloseTo(3 * k - 2 * d, 10);
    }
  });

  it("根數不足時 k／d／j 都是空", () => {
    expect(computeKdSeries(makeCandles(10, wave))).toEqual({ k: [], d: [], j: [] });
  });
});

describe("MACD 暖機：加上更早K線後，顯示區間第一個點就有值", () => {
  const all = makeCandles(63 + 150, wave); // 3個月顯示＋150根暖機
  const warm = all.slice(0, 150);
  const shown = all.slice(150);
  const from = shown[0].time;

  it("沒暖機：63根顯示資料只有最後約14根有 MACD（舊行為，這就是使用者看到的問題）", () => {
    expect(computeMacdSeries(shown).macd.length).toBeLessThan(20);
  });

  it("有暖機：可見範圍每一天都有 DIF／DEA／柱", () => {
    const m = computeMacdSeries([...warm, ...shown]);
    for (const series of [m.macd, m.signal, m.histogram]) {
      const visible = series.filter((p) => p.time >= from);
      expect(visible.length).toBe(shown.length);
      expect(visible[0].time).toBe(from);
    }
  });

  it("KD、RSI、MA60 暖機後同樣全範圍有值", () => {
    const kd = computeKdSeries([...warm, ...shown]);
    for (const series of [kd.k, kd.d, kd.j]) expect(series.filter((p) => p.time >= from).length).toBe(shown.length);
    expect(computeRsiSeries([...warm, ...shown]).filter((p) => p.time >= from).length).toBe(shown.length);
    expect(computeMaSeries([...warm, ...shown], 60).filter((p) => p.time >= from).length).toBe(shown.length);
  });

  it("MACD 數值：與 EMA12−EMA26 的獨立算法一致（等差數列 DIF 恆為常數）", () => {
    // 線性上升 close=i：EMA 的落後量固定，EMA12 − EMA26 → 趨近 (26−12)/2 = 7 的常數
    const m = computeMacdSeries(makeCandles(200, (i) => i));
    expect(m.macd[m.macd.length - 1].value).toBeCloseTo(7, 6);
    expect(m.histogram[m.histogram.length - 1].value).toBeCloseTo(0, 6);
  });
});

describe("trimIndicatorData", () => {
  it("丟掉早於顯示區間第一根的點，其餘原樣保留", () => {
    const out = trimIndicatorData(
      { a: [{ time: "2026-01-01", value: 1 }, { time: "2026-01-05", value: 2 }, { time: "2026-01-09", value: 3 }] },
      "2026-01-05"
    );
    expect(out.a.map((p) => p.value)).toEqual([2, 3]);
  });
});

describe("指標清單與暖機區間設定", () => {
  it("副圖順序 MACD、KDJ、RSI；KDJ 圖例含 K／D／J 三條", () => {
    expect(INDICATOR_DEFS.filter((d) => d.pane === "sub").map((d) => d.key)).toEqual(["macd", "kd", "rsi"]);
    expect(INDICATOR_DEFS.find((d) => d.key === "kd")!.legend!.items.map((i) => i.name)).toEqual(["k", "d", "j"]);
  });

  it("日線區間暖機區間一定比顯示區間長；當日走勢沒有暖機", () => {
    expect(CHART_WARMUP_RANGE["3m"]).toBe("1y");
    expect(CHART_WARMUP_RANGE["1y"]).toBe("2y");
    expect(CHART_WARMUP_RANGE.today).toBeUndefined();
  });
});
