import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableKv, assemble, durableTableOf } from "@/lib/data/durableKv";
import { MemoryStore, setStoreForTests, getStore, type Row } from "@/lib/auth/store";

function fakeCache() {
  const m = new Map<string, unknown>();
  return {
    get: async (k: string) => (m.has(k) ? m.get(k) : null),
    set: async (k: string, v: unknown) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    expireTag: async () => {},
  };
}

describe("DurableKv（快取＋試算表永久保存）", () => {
  beforeEach(() => setStoreForTests(new MemoryStore()));
  afterEach(() => setStoreForTests(null));

  it("哪些鍵要存試算表：鎖、執行標記不存", () => {
    expect(durableTableOf("rating-log:v1:2026-10-08")).toBe("RatingLog");
    expect(durableTableOf("sim-portfolio:v1:state")).toBe("SimPortfolio");
    expect(durableTableOf("sim-portfolio:v1:lock")).toBeNull();
    expect(durableTableOf("learning:v1:eval:2026-10-08")).toBe("Learning");
    expect(durableTableOf("learning:v1:lock")).toBeNull();
    expect(durableTableOf("learning:v1:done:2026-10-08")).toBeNull();
    expect(durableTableOf("chart:TW:2330:6m")).toBeNull();
  });

  it("寫入後換一個空快取（模擬被淘汰／新部署）也讀得回來：hash、清單順序、字串", async () => {
    const a = new DurableKv(fakeCache());
    await a.hsetnx("rating-log:v1:2026-10-08", "2330#buy", JSON.stringify({ symbol: "2330", price: 1000 }));
    await a.hsetnx("rating-log:v1:2026-10-08", "2330#buy", JSON.stringify({ symbol: "2330", price: 9 })); // 已存在不覆蓋
    await a.hset("rating-log:v1:2026-10-08", { "2317#avoid": JSON.stringify({ symbol: "2317" }) });
    await a.rpush("sim-portfolio:v1:trades:2026-10", "t1", "t2");
    await a.rpush("sim-portfolio:v1:trades:2026-10", "t3");
    await a.set("sim-portfolio:v1:state", JSON.stringify({ cash: 123 }));
    await a.set("sim-portfolio:v1:lock", "1", { nx: true, ex: 60 }); // 鎖不存試算表
    await a.flush();

    const b = new DurableKv(fakeCache());
    expect(await b.hget("rating-log:v1:2026-10-08", "2330#buy")).toEqual({ symbol: "2330", price: 1000 });
    expect(Object.keys((await b.hgetall("rating-log:v1:2026-10-08"))!).sort()).toEqual(["2317#avoid", "2330#buy"]);
    expect(await b.lrange("sim-portfolio:v1:trades:2026-10", 0, -1)).toEqual(["t1", "t2", "t3"]);
    expect(await b.get("sim-portfolio:v1:state")).toEqual({ cash: 123 });
    expect(await b.get("sim-portfolio:v1:lock")).toBeNull();
  });

  it("覆寫字串、刪除鍵、計數 hincrby 都同步到試算表", async () => {
    const a = new DurableKv(fakeCache());
    await a.set("brief-archive:v1:2026-10-08", "A");
    await a.set("brief-archive:v1:2026-10-08", "B");
    await a.pipeline().hincrby("ai-model-stats:v1:2026-10-08", "gemini|up", 1).hincrby("ai-model-stats:v1:2026-10-08", "gemini|up", 1).exec();
    await a.set("brief-archive:v1:2026-10-07", "old");
    await a.del("brief-archive:v1:2026-10-07");
    await a.flush();
    const b = new DurableKv(fakeCache());
    expect(await b.get("brief-archive:v1:2026-10-08")).toBe("B");
    expect(await b.hget("ai-model-stats:v1:2026-10-08", "gemini|up")).toBe(2);
    expect(await b.get("brief-archive:v1:2026-10-07")).toBeNull();
  });

  it("超過單格上限的長字串會切片存、讀回完整", async () => {
    const big = "x".repeat(100_000);
    const a = new DurableKv(fakeCache());
    await a.set("learning:v1:summary", big);
    await a.flush();
    const rows = (await getStore().batch([{ op: "read", table: "Learning" }]))[0] as Row[];
    expect(rows.length).toBe(3);
    expect((await new DurableKv(fakeCache()).get<string>("learning:v1:summary"))!.length).toBe(100_000);
  });

  it("pipeline 一次載入多個鍵（例如讀一段期間的評等紀錄）", async () => {
    const a = new DurableKv(fakeCache());
    for (const d of ["2026-10-06", "2026-10-07"]) await a.hset(`rating-log:v1:${d}`, { [`2330#buy`]: JSON.stringify({ day: d }) });
    await a.flush();
    const b = new DurableKv(fakeCache());
    const r = await b.pipeline().hgetall("rating-log:v1:2026-10-06").hgetall("rating-log:v1:2026-10-07").hgetall("rating-log:v1:2026-10-08").exec();
    expect(r).toEqual([{ "2330#buy": { day: "2026-10-06" } }, { "2330#buy": { day: "2026-10-07" } }, null]);
  });

  it("assemble：切片不齊時略過", () => {
    const rows: Row[] = [{ ID: "k§§0", Key: "k", Field: "", Part: "0", Parts: "2", Kind: "s", Value: "ab" }];
    expect(assemble(rows).size).toBe(0);
  });
});

describe("DurableKv：試算表壞掉時不影響功能", () => {
  afterEach(() => setStoreForTests(null));
  it("讀試算表失敗時照樣用快取運作", async () => {
    setStoreForTests({ kind: "gas", batch: async () => { throw new Error("未知的操作：readKeys"); } });
    const kv = new DurableKv(fakeCache());
    expect(await kv.hget("rating-log:v1:2026-10-08", "x")).toBeNull();
    await kv.hset("rating-log:v1:2026-10-08", { x: "1" });
    expect(await kv.hget("rating-log:v1:2026-10-08", "x")).toBe(1);
  });
});
