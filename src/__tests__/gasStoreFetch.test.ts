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

  /** 模擬 Apps Script 排不到鎖：前 n 次回「Lock timeout」，之後成功 */
  function lockyGas(lockFails: number) {
    let posts = 0;
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        posts++;
        return new Response(null, { status: 302, headers: { location: "https://script.googleusercontent.com/echo?x=1" } });
      }
      const body =
        posts <= lockFails
          ? { success: false, message: "系統錯誤：Lock timeout: another process was holding the lock for too long." }
          : { success: true, data: [true] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    return { fetchMock, posts: () => posts };
  }

  it("寫入排不到鎖（Lock timeout）：自動重送一次就成功，不會重複寫入", async () => {
    const g = lockyGas(1);
    vi.stubGlobal("fetch", g.fetchMock);
    const r = await getStore().batch([{ op: "update", table: "Users", key: "1", patch: { Name: "x" } }]);
    expect(r).toEqual([true]);
    expect(g.posts()).toBe(2);
  });

  it("一直排不到鎖：回中文說明，不顯示英文技術訊息", async () => {
    const g = lockyGas(99);
    vi.stubGlobal("fetch", g.fetchMock);
    const err = await getStore().batch([{ op: "update", table: "Users", key: "1", patch: { Name: "x" } }]).catch((e: Error) => e);
    expect((err as Error).message).toContain("比較忙");
    expect((err as Error).message).not.toMatch(/Lock timeout|aborted/i);
    expect(g.posts()).toBe(2);
  });

  it("讀取失敗但這台伺服器有舊資料：先用舊資料；寫入過的表不會拿到舊資料", async () => {
    vi.useFakeTimers();
    try {
      let broken = false;
      let posts = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
          if (init?.method === "POST") {
            posts++;
            if (broken) return new Response("<html>Service invoked too many times</html>", { status: 200 });
            return new Response(null, { status: 302, headers: { location: "https://script.googleusercontent.com/echo?x=1" } });
          }
          return new Response(JSON.stringify({ success: true, data: [[{ ID: "1", Name: "舊" }]] }), { status: 200 });
        }),
      );
      const store = getStore();
      await store.batch([{ op: "read", table: "Users" }]);
      broken = true;
      vi.setSystemTime(Date.now() + 2 * 60_000); // 暫存已過期（>60 秒）但還在 10 分鐘內
      expect(await store.batch([{ op: "read", table: "Users" }])).toEqual([[{ ID: "1", Name: "舊" }]]);
      vi.setSystemTime(Date.now() + 20 * 60_000); // 超過 10 分鐘：不能再用，要報錯
      await expect(store.batch([{ op: "read", table: "Users" }])).rejects.toThrow("回應開頭");
      expect(posts).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
