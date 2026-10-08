import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStore, setStoreForTests } from "@/lib/auth/store";

/** 模擬 Apps Script：POST 回 302 轉址，取結果的 GET 前幾次回 404（Google 偶發狀況） */
function fakeGas(opts: { fail404: number }) {
  let posts = 0;
  let gets = 0;
  let failsLeft = opts.fail404;
  let lastBody: { ops: Array<{ op: string; table: string }> } | null = null;
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      posts++;
      lastBody = JSON.parse(init.body!);
      return new Response(null, { status: 302, headers: { location: "https://script.googleusercontent.com/echo?x=1" } });
    }
    gets++;
    if (failsLeft > 0) {
      failsLeft--;
      return new Response("Not Found", { status: 404 });
    }
    const data = lastBody!.ops.map((o) => (o.op === "read" ? [{ ID: "1", Name: `${o.table}-row` }] : true));
    return new Response(JSON.stringify({ success: true, data }), { status: 200 });
  });
  return { fetchMock, counts: () => ({ posts, gets }) };
}

describe("GasStore：Google 轉址與 404 重取、讀取暫存", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_GAS_URL", "https://script.google.com/macros/s/x/exec");
    vi.stubEnv("AUTH_GAS_SECRET", "s");
    setStoreForTests(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    setStoreForTests(null);
  });

  it("寫入時取結果遇到 404：只重取結果、不重新執行（不會重複寫入）", async () => {
    const g = fakeGas({ fail404: 2 });
    vi.stubGlobal("fetch", g.fetchMock);
    const r = await getStore().batch([{ op: "append", table: "Strategies", row: { ID: "S1" } }]);
    expect(r).toEqual([true]);
    expect(g.counts()).toEqual({ posts: 1, gets: 3 });
  });

  it("讀過的表 60 秒內不再呼叫；寫入後作廢重讀；同一批只送沒暫存的表", async () => {
    const g = fakeGas({ fail404: 0 });
    vi.stubGlobal("fetch", g.fetchMock);
    const store = getStore();
    await store.batch([{ op: "read", table: "Users" }]);
    await store.batch([{ op: "read", table: "Users" }]);
    expect(g.counts().posts).toBe(1);
    const both = await store.batch([{ op: "read", table: "Users" }, { op: "read", table: "Sessions" }]);
    expect(both).toEqual([[{ ID: "1", Name: "Users-row" }], [{ ID: "1", Name: "Sessions-row" }]]);
    expect(g.counts().posts).toBe(2); // 只多送 Sessions
    await store.batch([{ op: "update", table: "Users", key: "1", patch: { Name: "x" } }]);
    await store.batch([{ op: "read", table: "Users" }]);
    expect(g.counts().posts).toBe(4); // 寫入 1 次＋重讀 1 次
  });

  it("一直 404 就回報錯誤", async () => {
    const g = fakeGas({ fail404: 99 });
    vi.stubGlobal("fetch", g.fetchMock);
    await expect(getStore().batch([{ op: "append", table: "Indicators", row: { ID: "I" } }])).rejects.toThrow("404");
  });
});
