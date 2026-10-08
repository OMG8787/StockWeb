import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, setStoreForTests } from "@/lib/auth/store";

// 股票名稱查詢不打網路
vi.mock("@/lib/data/universe", () => ({
  ensureTwUniverseWarm: async () => {},
  findInUniverse: (s: string) => (s === "2330" ? { name: "台積電" } : undefined),
}));

const {
  deleteIndicator, deleteSim, deleteStrategy, getSim, listIndicators, listSimHistory, listSims, listStrategies,
  persistSimResult, saveIndicator, saveSim, saveStrategy,
  toSim,
} = await import("@/lib/strategy/store");

const amy = { userId: "U1", account: "amy" };
const bob = { userId: "U2", account: "bob" };

describe("參考指標／策略庫／模擬倉儲存", () => {
  beforeEach(() => setStoreForTests(new MemoryStore()));
  afterEach(() => setStoreForTests(null));

  it("參考指標：參數整理、名稱預設、只看得到自己的", async () => {
    const a = await saveIndicator(amy, { typeId: "rsi", params: { period: 6, op: "lt", value: 25 } });
    expect(a.name).toBe("RSI(6) 低於 25");
    await saveIndicator(bob, { typeId: "pe", name: "低本益比" });
    expect((await listIndicators("U1")).map((x) => x.name)).toEqual(["RSI(6) 低於 25"]);
    await expect(saveIndicator(amy, { typeId: "nope" })).rejects.toThrow("指標類型");
    const edited = await saveIndicator(amy, { id: a.id, typeId: "rsi", name: "超賣", params: { period: 14 } });
    expect(edited).toMatchObject({ name: "超賣", params: { period: 14, op: "lt", value: 30 } });
    await expect(saveIndicator(bob, { id: a.id, typeId: "rsi" })).rejects.toThrow("找不到");
  });

  it("策略：只能用自己的指標；被模擬倉使用時不能刪；指標被策略使用時不能刪", async () => {
    const i1 = await saveIndicator(amy, { typeId: "rsi" });
    const bobInd = await saveIndicator(bob, { typeId: "rsi" });
    await expect(saveStrategy(amy, { name: "x", config: { buy: { ids: [bobInd.id] } } })).rejects.toThrow("至少要用到一個");
    const st = await saveStrategy(amy, { name: "超賣反彈", config: { buy: { ids: [i1.id], match: 0 } } });
    expect(st.summary).toContain("條件式");
    expect((await listStrategies("U1"))[0].config.buy.ids).toEqual([i1.id]);
    await expect(deleteIndicator(amy, i1.id)).rejects.toThrow("超賣反彈");
    const sim = await saveSim(amy, { name: "我的倉", strategyId: st.id, sources: [{ source: "list", symbols: ["2330", "2330", "bad!"] }, { source: "all" }], initialCash: 1_000_000 });
    expect(sim.symbols).toEqual([{ symbol: "2330", market: "TW", name: "台積電" }]);
    expect(sim.sources).toEqual([{ source: "list", symbols: ["2330"] }, { source: "all" }]);
    expect(sim.sourceMode).toBe("union");
    // 策略沒設定股票篩選，不能選「依策略選股」
    await expect(saveSim(amy, { name: "y", strategyId: st.id, sources: [{ source: "strategy" }], initialCash: 1_000_000 })).rejects.toThrow("股票篩選判斷");
    expect(sim).toMatchObject({ cash: 1_000_000, equity: 1_000_000, autoTrade: true });
    await expect(deleteStrategy(amy, st.id)).rejects.toThrow("我的倉");
    await deleteSim(amy, sim.id);
    await deleteStrategy(amy, st.id);
    await deleteIndicator(amy, i1.id);
    expect(await listIndicators("U1")).toEqual([]);
  });

  it("模擬倉：資金範圍、自動交易要有策略與股票、別人的看不到", async () => {
    await expect(saveSim(amy, { name: "x", initialCash: 100, autoTrade: false })).rejects.toThrow("初始資金");
    await expect(saveSim(amy, { name: "x", initialCash: 100_000 })).rejects.toThrow("要先選擇策略");
    await expect(saveSim(amy, { name: "x", initialCash: 100_000, autoTrade: false, sources: [{ source: "list", symbols: [] }] })).rejects.toThrow("至少要有一檔");
    const sim = await saveSim(amy, { name: "手動倉", initialCash: 100_000, autoTrade: false });
    await expect(getSim("U2", sim.id)).rejects.toThrow("找不到");
    expect(await listSims("U2")).toEqual([]);
  });

  it("寫回交易結果：狀態、交易紀錄、當天淨值（同一天重跑覆蓋）", async () => {
    const sim = await saveSim(amy, { name: "倉", initialCash: 100_000, autoTrade: false });
    const pos = [{ symbol: "2330", market: "TW" as const, name: "台積電", shares: 100, avgCost: 500, buyDay: "2026-10-08" }];
    const trade = { day: "2026-10-08", side: "buy" as const, market: "TW" as const, symbol: "2330", name: "台積電", shares: 100, price: 500, fee: 71, pnl: null, source: "auto" as const, reason: "測試" };
    await persistSimResult(sim, { cash: 49_929, positions: pos, equity: 99_929 }, [trade], { day: "2026-10-08", runNote: "掃描 1 檔", markRun: true, indexClose: 22000 });
    await persistSimResult(sim, { cash: 49_929, positions: pos, equity: 101_000 }, [], { day: "2026-10-08", runNote: "重跑", markRun: true, indexClose: 22100 });
    const after = await getSim("U1", sim.id);
    expect(after).toMatchObject({ cash: 49_929, equity: 101_000, returnPct: 1, lastRunDay: "2026-10-08", lastRunNote: "重跑", positions: pos });
    const h = await listSimHistory("U1", sim.id);
    expect(h.trades).toHaveLength(1);
    expect(h.trades[0]).toMatchObject({ side: "buy", symbol: "2330", shares: 100, fee: 71, pnl: null });
    expect(h.nav).toEqual([{ day: "2026-10-08", equity: 101_000, cash: 49_929, indexClose: 22100 }]);
    expect((await listSimHistory("U2", sim.id)).trades).toEqual([]);
  });

  it("舊的模擬倉（Universe／Symbols／MarketTopN）換算成股票來源", () => {
    expect(toSim({ ID: "a", Universe: "market", MarketTopN: "50" }).sources).toEqual([{ source: "metric", metric: "volume_today", position: "top", count: 50 }]);
    expect(toSim({ ID: "b", Universe: "strategy" }).sources).toEqual([{ source: "strategy" }]);
    expect(toSim({ ID: "c", Universe: "list", Symbols: JSON.stringify([{ symbol: "2330" }]) }).sources).toEqual([{ source: "list", symbols: ["2330"] }]);
    expect(toSim({ ID: "d", Universe: "list", Symbols: "[]" }).sources).toEqual([]);
  });
});
