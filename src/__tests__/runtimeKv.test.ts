import { describe, expect, it, vi } from "vitest";
import { RuntimeKv } from "@/lib/data/runtimeKv";

/** 簡單的假 Runtime Cache（記憶體，支援 ttl） */
function fakeCache() {
  const m = new Map<string, { v: unknown; until: number }>();
  return {
    get: async (k: string) => {
      const e = m.get(k);
      return e && e.until > Date.now() ? e.v : null;
    },
    set: async (k: string, v: unknown, o?: { ttl?: number }) => void m.set(k, { v, until: Date.now() + (o?.ttl ?? 1e6) * 1000 }),
    delete: async (k: string) => void m.delete(k),
    expireTag: async () => {},
  };
}

describe("RuntimeKv（以 Vercel Runtime Cache 模擬 Redis 指令）", () => {
  it("get 自動解析 JSON 字串（同 Upstash）、set nx、到期", async () => {
    const kv = new RuntimeKv(fakeCache());
    await kv.set("a", JSON.stringify({ x: 1 }));
    expect(await kv.get("a")).toEqual({ x: 1 });
    await kv.set("s", "hello");
    expect(await kv.get("s")).toBe("hello");
    expect(await kv.set("a", "y", { nx: true })).toBeNull();
    expect(await kv.set("lock", "1", { nx: true, ex: 60 })).toBe("OK");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    expect(await kv.get("lock")).toBeNull();
    vi.useRealTimers();
  });

  it("計數器、hash、set、list", async () => {
    const kv = new RuntimeKv(fakeCache());
    expect(await kv.incr("c")).toBe(1);
    expect(await kv.incr("c")).toBe(2);
    expect(await kv.decr("c")).toBe(1);
    await kv.hset("h", { a: JSON.stringify({ n: 1 }), b: "2" });
    expect(await kv.hsetnx("h", "a", "zz")).toBe(0);
    expect(await kv.hsetnx("h", "c", "3")).toBe(1);
    expect(await kv.hget("h", "a")).toEqual({ n: 1 });
    expect(await kv.hmget("h", "b", "nope")).toEqual([2, null]);
    expect(await kv.hincrby("h", "cnt", 5)).toBe(5);
    expect(Object.keys((await kv.hgetall("h"))!).sort()).toEqual(["a", "b", "c", "cnt"]);
    expect(await kv.hgetall("none")).toBeNull();
    await kv.sadd("set", "x", "y", "x");
    expect((await kv.smembers<string[]>("set")).sort()).toEqual(["x", "y"]);
    await kv.rpush("l", "1", "2", "3");
    expect(await kv.lrange("l", 0, -1)).toEqual([1, 2, 3]);
    expect(await kv.lrange("l", -2, -1)).toEqual([2, 3]);
  });

  it("pipeline 依序執行、可串接、回傳各結果", async () => {
    const kv = new RuntimeKv(fakeCache());
    const r = await kv.pipeline().hincrby("m", "x", 1).expire("m", 60).hgetall("m").exec();
    expect(r).toEqual([1, 1, { x: 1 }]);
  });
});
