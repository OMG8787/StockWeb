import { describe, expect, it, vi } from "vitest";
import { RuntimeKv } from "@/lib/data/runtimeKv";

/** 用記憶體版的 Redis 指令實作，並數「一共打了幾個指令」，確認讀評等紀錄不再逐日各讀一次 */
const state = vi.hoisted(() => ({ kv: null as unknown as InstanceType<typeof import("@/lib/data/runtimeKv").RuntimeKv>, cmds: 0 }));
vi.mock("@/lib/data/kv", async () => {
  const { RuntimeKv: Kv } = await import("@/lib/data/runtimeKv");
  const real = new Kv();
  const counted = new Proxy(real, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop === "pipeline") {
        return () => {
          const p = (v as () => Record<string, (...a: unknown[]) => unknown>).call(target);
          return new Proxy(p, {
            get(pt, pp, pr) {
              const f = Reflect.get(pt, pp, pr);
              return typeof f === "function" && pp !== "exec" ? (...a: unknown[]) => { state.cmds++; return (f as (...x: unknown[]) => unknown).apply(pt, a); } : f;
            },
          });
        };
      }
      return typeof v === "function" && ["get", "set", "sadd", "smembers", "hget", "hgetall", "hset", "hsetnx"].includes(String(prop))
        ? (...a: unknown[]) => { state.cmds++; return (v as (...x: unknown[]) => unknown).apply(target, a); }
        : v;
    },
  });
  state.kv = real;
  return { kvEnabled: true, redis: counted };
});

const { existingRatingLogDays, readRatingLog, ratingLogKey, ratingLogField, noteRatingLogDay } = await import("@/lib/ai/ratingLog");
const { redis } = await import("@/lib/data/kv");
const isoDay = (daysAgo: number) => new Date(Date.now() + 8 * 3600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);

describe("評等紀錄日期索引", () => {
  it("第一次建立索引；之後讀 200 天範圍只花個位數指令，而且資料不漏", async () => {
    const e = (day: string, symbol: string) => ({ day, symbol, market: "TW", code: "buy", at: `${day}T01:00:00Z`, name: symbol });
    // 舊資料：50 天前、20 天前各一天（不經過索引，模擬搬遷進來的資料）
    for (const d of [50, 20, 0]) await redis!.hset(ratingLogKey(isoDay(d)), { [ratingLogField("2330", "buy")]: JSON.stringify(e(isoDay(d), "2330")) });

    state.cmds = 0;
    const range = (n: number) => Array.from({ length: n }, (_, i) => isoDay(i));
    const first = await existingRatingLogDays(range(200));
    expect(first.sort()).toEqual([isoDay(0), isoDay(1), isoDay(2), isoDay(3), isoDay(20), isoDay(50)].sort()); // 有資料的 3 天＋最近 3 天一定保留
    const buildCost = state.cmds;
    expect(buildCost).toBeGreaterThan(300); // 一次性掃描

    state.cmds = 0;
    const log = await readRatingLog(isoDay(199), isoDay(0));
    expect(log.map((x) => x.day).sort()).toEqual([isoDay(50), isoDay(20), isoDay(0)].sort());
    expect(state.cmds).toBeLessThan(12); // 之前是 200 個
  });

  it("新寫入的日子立刻進索引；索引快取內也看得到", async () => {
    const day = isoDay(30);
    const p = redis!.pipeline();
    noteRatingLogDay(p as never, day);
    await p.exec();
    expect(await existingRatingLogDays([day, isoDay(31)])).toEqual([day]);
  });
});
void RuntimeKv;
