import { describe, expect, it } from "vitest";
import { MemoryStore, StoreUnavailableError, TABLE_KEYS, type StoreOp, type TableStore } from "@/lib/auth/store";
import { RedisTableStore, type HashClient } from "@/lib/auth/redisStore";

/** 模擬 Upstash：hash 欄位值存成 JSON 字串、讀出來自動還原成物件（跟真的一樣，才測得到序列化問題） */
function fakeUpstash(): HashClient & { commands: number; failNext: boolean } {
  const db = new Map<string, Map<string, string>>();
  const h = (k: string) => db.get(k) ?? db.set(k, new Map()).get(k)!;
  const out = (s: string | undefined) => (s === undefined ? null : JSON.parse(s));
  const self = {
    commands: 0,
    failNext: false,
    async hgetall(k: string) {
      self.commands++;
      if (self.failNext) throw new Error("ECONNRESET");
      const m = h(k);
      return m.size ? Object.fromEntries([...m].map(([f, v]) => [f, out(v)])) : null;
    },
    async hget(k: string, f: string) {
      self.commands++;
      return out(h(k).get(f));
    },
    async hmget(k: string, ...fs: string[]) {
      self.commands++;
      return Object.fromEntries(fs.map((f) => [f, out(h(k).get(f))]));
    },
    async hset(k: string, values: Record<string, unknown>) {
      self.commands++;
      for (const [f, v] of Object.entries(values)) h(k).set(f, JSON.stringify(v));
      return Object.keys(values).length;
    },
    async hdel(k: string, ...fs: string[]) {
      self.commands++;
      return fs.filter((f) => h(k).delete(f)).length;
    },
  };
  return self as HashClient & { commands: number; failNext: boolean };
}

const newRedis = () => new RedisTableStore(fakeUpstash(), TABLE_KEYS, (m) => new StoreUnavailableError(m, true));

async function runBoth(batches: StoreOp[][]) {
  const mem: TableStore = new MemoryStore();
  const red = newRedis();
  const results: Array<[unknown[], unknown[]]> = [];
  for (const ops of batches) results.push([await mem.batch(ops), await red.batch(ops)]);
  return results;
}

describe("RedisTableStore 與 MemoryStore（＝試算表版的行為）逐項一致", () => {
  it("新增、讀取（保持寫入順序）、更新、刪除、不存在的回傳值", async () => {
    const r = await runBoth([
      [{ op: "append", table: "Users", row: { UserId: "U1", Account: "amy", Name: "艾咪" } }],
      [{ op: "append", table: "Users", row: { UserId: "U2", Account: "bob", Name: "鮑伯" } }],
      [{ op: "append", table: "Users", row: { UserId: "U3", Account: "cat", Name: "凱特" } }],
      [{ op: "read", table: "Users" }],
      [{ op: "update", table: "Users", key: "U2", patch: { Name: "鮑伯二世", Note: 5 as unknown as string } }],
      [{ op: "update", table: "Users", key: "NOPE", patch: { Name: "x" } }],
      [{ op: "read", table: "Users" }],
      [{ op: "delete", table: "Users", key: "U1" }],
      [{ op: "delete", table: "Users", key: "U1" }],
      [{ op: "read", table: "Users" }],
    ]);
    for (const [mem, red] of r) expect(red).toEqual(mem);
    expect((r[3][1][0] as Array<{ Account: string }>).map((x) => x.Account)).toEqual(["amy", "bob", "cat"]);
  });

  it("readKeys、upsert（合併既有欄位、新列排在最後）、deleteWhere、replaceWhere", async () => {
    const r = await runBoth([
      [{ op: "append", table: "Holdings", row: { ID: "H1", UserId: "U1", Symbol: "2330" } }],
      [{ op: "append", table: "Holdings", row: { ID: "H2", UserId: "U2", Symbol: "2317" } }],
      [{ op: "append", table: "Holdings", row: { ID: "H3", UserId: "U1", Symbol: "2454" } }],
      [{ op: "readKeys", table: "Holdings", col: "UserId", values: ["U1"] }],
      [{ op: "upsert", table: "Holdings", rows: [{ ID: "H2", Qty: "5" }, { ID: "H9", UserId: "U9", Symbol: "AAPL" }] }],
      [{ op: "read", table: "Holdings" }],
      [{ op: "replaceWhere", table: "Holdings", col: "UserId", value: "U1", rows: [{ ID: "H10", UserId: "U1", Symbol: "0050" }] }],
      [{ op: "read", table: "Holdings" }],
      [{ op: "deleteWhere", table: "Holdings", col: "UserId", values: ["U9", "U2"] }],
      [{ op: "deleteWhere", table: "Holdings", col: "UserId", values: ["nobody"] }],
      [{ op: "read", table: "Holdings" }],
      [{ op: "replaceWhere", table: "Holdings", col: "UserId", value: "U1", rows: [] }],
      [{ op: "read", table: "Holdings" }],
    ]);
    for (const [mem, red] of r) expect(red).toEqual(mem);
  });

  it("trim 保留最後 N 筆（最少 50）、同一批多個操作依序生效", async () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ ID: `L${String(i).padStart(3, "0")}`, Account: "amy" }));
    const r = await runBoth([
      rows.map((row) => ({ op: "append" as const, table: "LoginLog" as const, row })),
      [{ op: "trim", table: "LoginLog", keep: 10 }, { op: "read", table: "LoginLog" }],
      [{ op: "append", table: "LoginLog", row: { ID: "NEW", Account: "z" } }, { op: "update", table: "LoginLog", key: "NEW", patch: { Account: "y" } }, { op: "readKeys", table: "LoginLog", col: "Account", values: ["y"] }],
    ]);
    for (const [mem, red] of r) expect(red).toEqual(mem);
    expect((r[1][1][1] as unknown[]).length).toBe(50);
  });

  it("寫入後馬上讀得到（暫存會作廢）；沒寫過的表 2 秒內重複讀只花 1 個指令", async () => {
    const client = fakeUpstash();
    const store = new RedisTableStore(client, TABLE_KEYS, (m) => new StoreUnavailableError(m, true));
    await store.batch([{ op: "read", table: "Sims" }]);
    await store.batch([{ op: "read", table: "Sims" }]);
    expect(client.commands).toBe(1);
    await store.batch([{ op: "append", table: "Sims", row: { ID: "S1", Name: "倉" } }]);
    expect(await store.batch([{ op: "read", table: "Sims" }])).toEqual([[{ ID: "S1", Name: "倉" }]]);
  });

  it("Redis 連不上：丟出可重試的中文錯誤，不洩漏英文技術訊息", async () => {
    const client = fakeUpstash();
    const store = new RedisTableStore(client, TABLE_KEYS, (m) => new StoreUnavailableError(m, true));
    client.failNext = true;
    const err = await store.batch([{ op: "read", table: "Users" }]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(StoreUnavailableError);
    expect((err as Error).message).toContain("Redis");
    expect((err as Error).message).not.toMatch(/ECONNRESET/);
  });
});
