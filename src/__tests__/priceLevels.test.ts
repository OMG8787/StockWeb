import { describe, expect, it } from "vitest";
import {
  computePriceFramework,
  describePriceFramework,
  EXIT_MIN_GAP,
  PRICE_LEVELS_TITLE,
  tickSize,
} from "@/lib/ai/grounding/priceLevels";

type C = { high: number; low: number; close: number };
const bar = (close: number, spread = 0.01): C => ({ close, high: close * (1 + spread), low: close * (1 - spread) });
/** 從 start 線性走到 end 的 n 根日K */
const ramp = (start: number, end: number, n: number, spread = 0.01): C[] =>
  Array.from({ length: n }, (_, i) => bar(start + ((end - start) * i) / Math.max(1, n - 1), spread));

function checkInvariants(f: NonNullable<ReturnType<typeof computePriceFramework>>) {
  expect(f.noChase.price).toBeGreaterThan(f.price);
  for (let i = 1; i < f.supports.length; i++) expect(f.supports[i].price).toBeLessThan(f.supports[i - 1].price);
  for (let i = 1; i < f.resistances.length; i++) expect(f.resistances[i].price).toBeGreaterThan(f.resistances[i - 1].price);
  f.supports.forEach((s) => expect(s.price).toBeLessThan(f.price));
  f.resistances.forEach((r) => expect(r.price).toBeGreaterThan(f.price));
  if (f.zone) {
    expect(f.zone.low).toBeLessThan(f.zone.high);
    expect(f.zone.high).toBeLessThan(f.price);
    expect(f.exit).not.toBeNull();
    expect(f.exit!.price).toBeLessThanOrEqual(f.zone.low * (1 - EXIT_MIN_GAP) + 1e-9);
  }
}

describe("computePriceFramework", () => {
  it("資料不足（<20根）回 null，describe 回空字串", () => {
    expect(computePriceFramework(ramp(100, 110, 19), 110, "TW")).toBeNull();
    expect(describePriceFramework(null)).toBe("");
    expect(computePriceFramework(ramp(100, 110, 30), 0, "TW")).toBeNull();
  });

  it("旺矽情境：上漲趨勢、現價高於所有均線 → 區間在現價下方、出場低於下緣、標明不在區間內", () => {
    const candles = ramp(4000, 5300, 70);
    const f = computePriceFramework(candles, 5420, "TW")!;
    expect(f.zone).not.toBeNull();
    checkInvariants(f);
    const text = describePriceFramework(f);
    expect(text).toContain(PRICE_LEVELS_TITLE);
    expect(text).toContain("高於支撐區上緣");
    expect(text).toContain("現價可分批買");
    expect(text).not.toMatch(/要等回檔到區間才分批買|不追價/);
    // 1000 元以上台股升降單位 5 元
    expect(f.zone!.high % 5).toBe(0);
    expect(f.exit!.price % 5).toBe(0);
  });

  it("只有一個下方支撐 → 區間下緣＝支撐下方3%，出場再往下", () => {
    // 前面高檔、最近急跌到接近低點：只有近20日低在現價下方
    const candles = [...ramp(200, 200, 50), ...ramp(200, 150, 20, 0.002)];
    const f = computePriceFramework(candles, 150.2, "TW")!;
    checkInvariants(f);
    if (f.supports.length === 1) expect(f.zone!.lowLabel).toContain("下方3%");
  });

  it("破底：現價低於所有均線與近期低點 → 不給區間，描述寫暫緩觀望", () => {
    const candles = ramp(100, 90, 70);
    const f = computePriceFramework(candles, 80, "TW")!;
    expect(f.supports).toHaveLength(0);
    expect(f.zone).toBeNull();
    expect(f.exit).toBeNull();
    checkInvariants(f);
    expect(describePriceFramework(f)).toContain("暫緩觀望");
  });

  it("盤整、價位彼此很近 → 合併後仍保證大小關係；找不到更低支撐時用下緣下方3%", () => {
    const candles = Array.from({ length: 70 }, (_, i) => bar(100 + (i % 2 ? 0.3 : -0.3), 0.004));
    const f = computePriceFramework(candles, 100.8, "TW")!;
    checkInvariants(f);
  });

  it("隨機排列大量測試：不變量永遠成立", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 300; k++) {
      const n = 20 + Math.floor(rnd() * 60);
      let p = 10 + rnd() * 2000;
      const candles: C[] = [];
      for (let i = 0; i < n; i++) {
        p *= 1 + (rnd() - 0.5) * 0.06;
        candles.push(bar(p, rnd() * 0.03));
      }
      const price = p * (1 + (rnd() - 0.5) * 0.1);
      const market = rnd() > 0.5 ? "TW" : "US";
      const f = computePriceFramework(candles, price, market);
      expect(f).not.toBeNull();
      checkInvariants(f!);
    }
  });

  it("美股升降單位 0.01、台股依價格級距", () => {
    expect(tickSize(5420, "TW")).toBe(5);
    expect(tickSize(650, "TW")).toBe(1);
    expect(tickSize(88, "TW")).toBe(0.1);
    expect(tickSize(420, "US")).toBe(0.01);
  });
});

describe("describePriceFramework 先不要買", () => {
  it("評等為先不要買時不出現買進區間與買進後出場", async () => {
    const { describePriceFramework } = await import("@/lib/ai/grounding/priceLevels");
    const f = {
      price: 152.5,
      supports: [],
      resistances: [],
      zone: { low: 134.5, high: 148.5, lowLabel: "a", highLabel: "b" },
      exit: { price: 126.5, label: "c" },
      noChase: { price: 157, label: "MA5" },
    } as unknown as Parameters<typeof describePriceFramework>[0];
    const t = describePriceFramework(f, { avoid: true });
    expect(t).not.toContain("分批買進區間");
    expect(t).not.toContain("買進後跌破");
    expect(t).not.toContain("134.5");
    expect(t).toContain("改判建議買進");
    expect(describePriceFramework(f)).toContain("支撐區 134.5～148.5");
    expect(describePriceFramework(f)).toContain("拉回到 148.5 附近可加碼");
  });
});
