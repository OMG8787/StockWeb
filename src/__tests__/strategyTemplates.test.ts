import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, setStoreForTests } from "@/lib/auth/store";
import { INDICATOR_TYPE_MAP, normalizeParams } from "@/lib/strategy/indicatorCatalog";
import { STRATEGY_TEMPLATES } from "@/lib/strategy/templates";

vi.mock("@/lib/data/universe", () => ({ ensureTwUniverseWarm: async () => {}, findInUniverse: () => undefined }));

const { createFromTemplate } = await import("@/lib/strategy/templateCreate");
const { listIndicators, listStrategies } = await import("@/lib/strategy/store");

const amy = { userId: "U1", account: "amy" };

describe("策略範本", () => {
  it("每個範本的指標類型存在、參數合法（整理後不變）、條件都對得到指標、可回測標示正確", () => {
    for (const t of STRATEGY_TEMPLATES) {
      const keys = new Set(t.indicators.map((i) => i.key));
      for (const i of t.indicators) {
        const type = INDICATOR_TYPE_MAP.get(i.typeId);
        expect(type, `${t.id}:${i.typeId}`).toBeTruthy();
        expect(normalizeParams(i.typeId, i.params)).toEqual({ ...normalizeParams(i.typeId, {}), ...i.params });
      }
      for (const k of [...t.buy.keys, ...t.sell.keys]) expect(keys.has(k), `${t.id}:${k}`).toBe(true);
      const candleOnly = t.indicators.every((i) => INDICATOR_TYPE_MAP.get(i.typeId)!.needs.every((n) => n === "candles"));
      expect(t.backtestable, t.id).toBe(candleOnly);
    }
  });

  describe("一鍵建立", () => {
    beforeEach(() => setStoreForTests(new MemoryStore()));
    afterEach(() => setStoreForTests(null));

    it("建立指標與策略；再建一次沿用相同指標、策略名稱加（2）", async () => {
      const t = STRATEGY_TEMPLATES.find((x) => x.id === "macd-trend")!;
      const a = await createFromTemplate(amy, t.id);
      expect(a.createdIndicators).toBe(t.indicators.length);
      expect(a.name).toBe(t.name);
      const st = (await listStrategies("U1"))[0];
      expect(st.config.buy.ids).toHaveLength(2);
      expect(st.config.stopLossPct).toBe(t.stopLossPct);
      const b = await createFromTemplate(amy, t.id);
      expect(b.createdIndicators).toBe(0);
      expect(b.name).toBe(`${t.name}（2）`);
      expect(await listIndicators("U1")).toHaveLength(t.indicators.length);
      await expect(createFromTemplate(amy, "nope")).rejects.toThrow("找不到");
    });
  });
});
