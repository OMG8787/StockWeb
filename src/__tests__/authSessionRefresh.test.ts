import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUser, login, setupFirstAdmin, updateUser } from "@/lib/auth/accounts";
import { MemoryStore, setStoreForTests } from "@/lib/auth/store";
import { refreshSession, type MiniKv } from "@/lib/auth/sessionRefresh";
import { REVALIDATE_MS } from "@/lib/auth/sessionCookie";
import { PERM } from "@/lib/auth/permissions";

const info = { device: "t", userAgent: "t", ip: "" };

function fakeKv(): MiniKv & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(k: string) {
      return (data.get(k) as T) ?? null;
    },
    async set(k, v, opts) {
      if (opts.nx && data.has(k)) return null;
      data.set(k, v);
      return "OK";
    },
  };
}

describe("背景登入確認（sessionRefresh）", () => {
  beforeEach(() => setStoreForTests(new MemoryStore()));
  afterEach(() => setStoreForTests(null));

  async function setup() {
    const admin = await setupFirstAdmin({ account: "boss", name: "老闆", password: "boss-pass-1", code: "" }, info);
    const { user, tempPassword } = await createUser(admin, { account: "amy", perms: [PERM.MARKET] });
    const s = await login("amy", tempPassword, info);
    return { admin, user, s };
  }

  it("還沒到確認時間就不做任何事", async () => {
    const { s } = await setup();
    const jobs: Promise<unknown>[] = [];
    expect(await refreshSession(s, fakeKv(), (p) => jobs.push(p), s.chk + 1000)).toEqual({ kind: "keep" });
    expect(jobs).toHaveLength(0);
  });

  it("有 Redis：這次放行並排背景確認，下一次請求套用新權限；同時間只排一次", async () => {
    const { admin, user, s } = await setup();
    await updateUser(admin, user.userId, { perms: [PERM.MARKET, PERM.ACTION] });
    const kv = fakeKv();
    const jobs: Promise<unknown>[] = [];
    const later = s.chk + REVALIDATE_MS + 1;
    expect(await refreshSession(s, kv, (p) => jobs.push(p), later)).toEqual({ kind: "keep" });
    expect(await refreshSession(s, kv, (p) => jobs.push(p), later)).toEqual({ kind: "keep" });
    expect(jobs).toHaveLength(1); // 鎖住了，不重複打試算表
    await Promise.all(jobs);
    const next = await refreshSession(s, kv, () => {}, later + 10);
    expect(next.kind).toBe("refresh");
    if (next.kind === "refresh") {
      expect(next.session.perms).toEqual([PERM.MARKET, PERM.ACTION]);
      expect(next.session.t).toBe(s.t); // 憑證不存進 Redis，從 cookie 帶回
    }
    expect(JSON.stringify([...kv.data.values()])).not.toContain(s.t);
  });

  it("有 Redis：套用結果後 5 分鐘會再排下一次確認（不會一直重用同一筆舊結果）", async () => {
    const { s } = await setup();
    const kv = fakeKv();
    const jobs: Promise<unknown>[] = [];
    const t1 = s.chk + REVALIDATE_MS + 1;
    await refreshSession(s, kv, (p) => jobs.push(p), t1);
    await Promise.all(jobs);
    const r1 = await refreshSession(s, kv, () => {}, t1 + 10);
    expect(r1.kind).toBe("refresh");
    if (r1.kind !== "refresh") return;
    expect(r1.session.chk).toBe(t1);
    // 剛套用：還沒到確認時間
    expect(await refreshSession(r1.session, kv, () => {}, t1 + 1000)).toEqual({ kind: "keep" });
    // 5 分鐘後：舊結果不能再用，要排新的背景確認（鎖已過期）
    kv.data.delete("auth:rvlock:" + s.sid);
    const jobs2: Promise<unknown>[] = [];
    expect(await refreshSession(r1.session, kv, (p) => jobs2.push(p), t1 + REVALIDATE_MS + 5)).toEqual({ kind: "keep" });
    expect(jobs2).toHaveLength(1);
  });

  it("有 Redis：帳號停用後，背景確認完成的下一次請求就登出", async () => {
    const { admin, user, s } = await setup();
    await updateUser(admin, user.userId, { isActive: false });
    const kv = fakeKv();
    const jobs: Promise<unknown>[] = [];
    const later = s.chk + REVALIDATE_MS + 1;
    await refreshSession(s, kv, (p) => jobs.push(p), later);
    await Promise.all(jobs);
    expect(await refreshSession(s, kv, () => {}, later + 10)).toEqual({ kind: "revoked" });
  });

  it("沒有 Redis：同步確認", async () => {
    const { admin, user, s } = await setup();
    await updateUser(admin, user.userId, { isActive: false });
    expect(await refreshSession(s, null, () => {}, s.chk + REVALIDATE_MS + 1)).toEqual({ kind: "revoked" });
  });
});
