import { describe, expect, it, vi } from "vitest";

const screen = vi.hoisted(() => ({ watchlist: [{ symbol: "2330", market: "TW", name: "台積電" }, { symbol: "AAPL", market: "US", name: "Apple" }] as unknown[] | "fail", ai: [{ symbol: "2330", market: "TW", name: "台積電" }, { symbol: "6285", market: "TW", name: "啟碁" }] as unknown[] | "fail" }));
vi.mock("@/lib/strategy/screen", () => ({
  runScreen: async (cfg: { source: string }) => {
    const v = cfg.source === "watchlist" ? screen.watchlist : screen.ai;
    if (v === "fail") throw new Error("暫時讀不到");
    return v;
  },
}));
vi.mock("@/lib/strategy/store", () => ({ ALERT_LIMITS: { maxSymbols: 4 } }));

const { resolveTracked } = await import("@/lib/strategy/alertTargets");

describe("即時提醒追蹤名單來源", () => {
  it("手動優先、關注清單、AI 名單合併去重，標示每檔來源，超過上限截斷", async () => {
    const r = await resolveTracked("U1", { symbols: ["2317", "2330"], strategyIds: ["ai"], trackWatchlist: true, trackAiPicks: true });
    expect(r.symbols).toEqual(["2317", "2330", "AAPL", "6285"]);
    expect(r.sources["2330"]).toEqual(["manual", "watchlist", "ai"]);
    expect(r.sources["6285"]).toEqual(["ai"]);
    expect(r.lists.ai?.map((x) => x.symbol)).toEqual(["2330", "6285"]);
    expect(r.truncated).toBe(false);
    const more = await resolveTracked("U1", { symbols: ["1101", "1102", "1216"], strategyIds: [], trackWatchlist: true });
    expect(more.symbols).toHaveLength(4);
    expect(more.truncated).toBe(true);
  });

  it("沒勾選的來源 lists 為 null；讀不到也是 null（不是空陣列），其他來源照常", async () => {
    const off = await resolveTracked("U1", { symbols: ["2317"], strategyIds: [] });
    expect(off.lists).toEqual({ watchlist: null, ai: null });
    screen.ai = "fail";
    const r = await resolveTracked("U1", { symbols: [], strategyIds: [], trackWatchlist: true, trackAiPicks: true });
    expect(r.lists.ai).toBeNull();
    expect(r.lists.watchlist?.length).toBe(2);
    expect(r.symbols).toEqual(["2330", "AAPL"]);
  });
});
