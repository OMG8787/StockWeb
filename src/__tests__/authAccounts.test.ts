import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthError,
  adminOverview,
  changePassword,
  createUser,
  hashPassword,
  kick,
  FORGOT_REPLY,
  login,
  logout,
  register,
  requestPasswordReset,
  reviewUser,
  resetUserPassword,
  revalidate,
  setupFirstAdmin,
  updateUser,
  verifyPassword,
} from "@/lib/auth/accounts";
import { MemoryStore, setStoreForTests } from "@/lib/auth/store";
import { PERM, canSeePath, hasPerm, parsePerms, routeAccess } from "@/lib/auth/permissions";
import { NextResponse } from "next/server";
import { decodeSession, encodeSession, writeSessionCookies } from "@/lib/auth/sessionCookie";

const info = { device: "Windows・Chrome", userAgent: "test", ip: "127.0.0.1" };

async function seedAdmin() {
  return setupFirstAdmin({ account: "boss", name: "老闆", password: "boss-pass-1", code: "" }, info);
}

describe("帳號系統", () => {
  beforeEach(() => setStoreForTests(new MemoryStore()));
  afterEach(() => setStoreForTests(null));

  it("密碼雜湊可驗證、錯誤密碼不通過", () => {
    const h = hashPassword("abcdefgh");
    expect(verifyPassword("abcdefgh", h)).toBe(true);
    expect(verifyPassword("abcdefgi", h)).toBe(false);
    expect(verifyPassword("abcdefgh", "garbage")).toBe(false);
  });

  it("第一個管理員擁有全部權限，之後不能再建立", async () => {
    const admin = await seedAdmin();
    expect(admin.perms).toContain(PERM.SUPER_ADMIN);
    await expect(seedAdmin()).rejects.toThrow(AuthError);
  });

  it("管理員建立帳號 → 臨時密碼登入 → 必須改密碼 → 改完可正常使用", async () => {
    const admin = await seedAdmin();
    const { tempPassword } = await createUser(admin, { account: "amy", name: "Amy", perms: [PERM.MARKET, PERM.AI_CHAT] });
    const s = await login("AMY", tempPassword, info); // 帳號不分大小寫
    expect(s.mcp).toBe(true);
    expect(s.perms).toEqual([PERM.MARKET, PERM.AI_CHAT]);
    const after = await changePassword(s, tempPassword, "amy-new-pass");
    expect(after.mcp).toBe(false);
    await expect(login("amy", tempPassword, info)).rejects.toThrow("帳號或密碼錯誤");
    expect((await login("amy", "amy-new-pass", info)).mcp).toBe(false);
  });

  it("權限修改會在下一次確認登入時生效；停用帳號會讓登入失效", async () => {
    const admin = await seedAdmin();
    const { user, tempPassword } = await createUser(admin, { account: "bob", perms: [PERM.MARKET] });
    const s = await login("bob", tempPassword, info);
    await updateUser(admin, user.userId, { perms: [PERM.MARKET, PERM.ACTION], strategy: "swing" });
    const r1 = await revalidate(s);
    expect(r1.payload?.perms).toEqual([PERM.MARKET, PERM.ACTION]);
    expect(r1.payload?.strategy).toBe("swing");
    await updateUser(admin, user.userId, { isActive: false });
    expect((await revalidate(s)).payload).toBeNull();
    await expect(login("bob", tempPassword, info)).rejects.toThrow("停用");
  });

  it("強制登出與登出都會讓該登入失效，並寫進登入紀錄", async () => {
    const admin = await seedAdmin();
    const { tempPassword } = await createUser(admin, { account: "cat", perms: [PERM.MARKET] });
    const s1 = await login("cat", tempPassword, info);
    const s2 = await login("cat", tempPassword, info);
    expect(await kick(admin, { sessionId: s1.sid })).toBe(1);
    expect((await revalidate(s1)).payload).toBeNull();
    expect((await revalidate(s2)).payload).not.toBeNull();
    await logout(s2);
    expect((await revalidate(s2)).payload).toBeNull();
    const ov = await adminOverview(admin);
    const reasons = ov.loginLog.filter((l) => l.account === "cat").map((l) => l.endReason);
    expect(reasons).toContain("登出");
    expect(reasons.some((r) => r.startsWith("強制登出"))).toBe(true);
    expect(ov.sessions.some((x) => x.isMe)).toBe(true);
  });

  it("連續輸錯 5 次會暫時鎖住", async () => {
    const admin = await seedAdmin();
    const { tempPassword } = await createUser(admin, { account: "dan", perms: [PERM.MARKET] });
    for (let i = 0; i < 5; i++) await expect(login("dan", "wrong-pass", info)).rejects.toThrow();
    await expect(login("dan", tempPassword, info)).rejects.toThrow("嘗試次數過多");
  });

  it("非管理員不能用管理功能；只有最高管理員能授予 13；不能移除自己的管理權限", async () => {
    const admin = await seedAdmin();
    const { user: sub, tempPassword } = await createUser(admin, { account: "sub", perms: [PERM.ADMIN, PERM.MARKET] });
    const subSession = await login("sub", tempPassword, info);
    await expect(createUser(subSession, { account: "x13", perms: [PERM.SUPER_ADMIN] })).rejects.toThrow("最高管理員");
    await expect(resetUserPassword(subSession, admin.uid)).rejects.toThrow("最高管理員");
    await expect(updateUser(subSession, sub.userId, { perms: [PERM.MARKET] })).rejects.toThrow("自己的管理權限");
    const { tempPassword: pw } = await createUser(admin, { account: "plain", perms: [PERM.MARKET] });
    const plain = await login("plain", pw, info);
    await expect(adminOverview(plain)).rejects.toThrow("沒有系統管理權限");
  });

  it("重設密碼會登出對方所有裝置並要求改密碼", async () => {
    const admin = await seedAdmin();
    const { user, tempPassword } = await createUser(admin, { account: "eve", perms: [PERM.MARKET] });
    const s = await login("eve", tempPassword, info);
    const { tempPassword: pw2 } = await resetUserPassword(admin, user.userId);
    expect((await revalidate(s)).payload).toBeNull();
    expect((await login("eve", pw2, info)).mcp).toBe(true);
  });
});

describe("申請帳號、審核、忘記密碼", () => {
  beforeEach(() => setStoreForTests(new MemoryStore()));
  afterEach(() => setStoreForTests(null));

  it("還沒有管理員時不能申請", async () => {
    await expect(register({ account: "amy", name: "Amy", password: "amy-pass-1", contact: "amy@x.com" })).rejects.toThrow("管理員");
  });

  it("申請 → 待審核不能登入 → 核准並設權限 → 可登入", async () => {
    const admin = await seedAdmin();
    await register({ account: "amy", name: "Amy", password: "amy-pass-1", contact: "amy@x.com" });
    await expect(register({ account: "AMY", name: "x", password: "xxxx-pass", contact: "x@x.com" })).rejects.toThrow("已經有人使用");
    await expect(login("amy", "amy-pass-1", info)).rejects.toThrow("審核中");
    const ov = await adminOverview(admin);
    const amy = ov.users.find((u) => u.account === "amy")!;
    expect(amy).toMatchObject({ approval: "待審核", contact: "amy@x.com", perms: [] });
    await reviewUser(admin, amy.userId, "approve", { perms: [PERM.MARKET, PERM.AI_CHAT], strategy: "long" });
    const s = await login("amy", "amy-pass-1", info);
    expect(s).toMatchObject({ perms: [PERM.MARKET, PERM.AI_CHAT], strategy: "long", mcp: false });
  });

  it("拒絕後不能登入；一般帳號不能審核", async () => {
    const admin = await seedAdmin();
    await register({ account: "bob", name: "Bob", password: "bob-pass-1", contact: "0912345678" });
    const bob = (await adminOverview(admin)).users.find((u) => u.account === "bob")!;
    const { tempPassword } = await createUser(admin, { account: "plain", perms: [PERM.MARKET] });
    const plain = await login("plain", tempPassword, info);
    await expect(reviewUser(plain, bob.userId, "approve", { perms: [PERM.SUPER_ADMIN] })).rejects.toThrow("沒有系統管理權限");
    await reviewUser(admin, bob.userId, "reject");
    await expect(login("bob", "bob-pass-1", info)).rejects.toThrow("未通過");
  });

  it("忘記密碼：資料對才標記申請，回覆一律相同；管理員重設後清除標記", async () => {
    const admin = await seedAdmin();
    await register({ account: "cat", name: "Cat", password: "cat-pass-1", contact: "Cat@Mail.com" });
    const cat = (await adminOverview(admin)).users.find((u) => u.account === "cat")!;
    await reviewUser(admin, cat.userId, "approve", { perms: [PERM.MARKET] });
    expect(await requestPasswordReset("nobody", "x@x.com")).toBe(FORGOT_REPLY);
    expect(await requestPasswordReset("cat", "wrong@mail.com")).toBe(FORGOT_REPLY);
    expect((await adminOverview(admin)).users.find((u) => u.account === "cat")!.resetRequestedAt).toBe("");
    expect(await requestPasswordReset("CAT", " cat@mail.com ")).toBe(FORGOT_REPLY); // 不分大小寫、忽略空白
    const flagged = (await adminOverview(admin)).users.find((u) => u.account === "cat")!;
    expect(flagged.resetRequestedAt).not.toBe("");
    await resetUserPassword(admin, cat.userId);
    expect((await adminOverview(admin)).users.find((u) => u.account === "cat")!.resetRequestedAt).toBe("");
  });

  it("待審核的申請有上限", async () => {
    await seedAdmin();
    for (let i = 0; i < 30; i++) await register({ account: `p${i}xx`, name: "p", password: "pppp-pass", contact: "p@p.com" });
    await expect(register({ account: "p99xx", name: "p", password: "pppp-pass", contact: "p@p.com" })).rejects.toThrow("太多");
  });
});

describe("權限與網址", () => {
  it("網址對應的權限", () => {
    expect(routeAccess("/login")).toEqual({ kind: "public" });
    expect(routeAccess("/api/cron/warm-cache")).toEqual({ kind: "public" });
    expect(routeAccess("/account")).toEqual({ kind: "user", need: [] });
    expect(routeAccess("/api/auth/register")).toEqual({ kind: "public" });
    expect(routeAccess("/api/auth/forgot")).toEqual({ kind: "public" });
    expect(routeAccess("/api/admin/review")).toEqual({ kind: "user", need: [PERM.ADMIN] });
    expect(routeAccess("/api/auth/logout")).toEqual({ kind: "user", need: [] });
    expect(routeAccess("/admin")).toEqual({ kind: "user", need: [PERM.ADMIN] });
    expect(routeAccess("/api/ask-feedback")).toEqual({ kind: "user", need: [PERM.AI_CHAT] });
    expect(routeAccess("/action")).toEqual({ kind: "user", need: [PERM.ACTION] });
    expect(routeAccess("/stock/2330")).toEqual({ kind: "user", need: [PERM.MARKET] });
    expect(routeAccess("/")).toEqual({ kind: "user", need: [PERM.MARKET] });
  });

  it("最高管理員不受限制、未知代碼會被忽略", () => {
    expect(hasPerm([PERM.SUPER_ADMIN], [PERM.ACTION])).toBe(true);
    expect(canSeePath([PERM.MARKET], "/portfolio")).toBe(false);
    expect(parsePerms("30, 31|99,abc")).toEqual([30, 31]);
  });

  it("登入 cookie 被竄改就無效", () => {
    const v = encodeSession({ t: "tok", sid: "S1", uid: "U1", acc: "a", name: "A", perms: [30], strategy: "default", mcp: false, chk: 1 });
    expect(decodeSession(v)?.uid).toBe("U1");
    const [body, mac] = v.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), perms: [13] })).toString("base64url");
    expect(decodeSession(`${forged}.${mac}`)).toBeNull();
    expect(decodeSession("granted")).toBeNull();
  });

  it("畫面用的 sw_profile cookie 只編碼一次（前端 decodeURIComponent 一次就能解析）", () => {
    const res = NextResponse.json({});
    writeSessionCookies(res, { t: "tok", sid: "S1", uid: "U1", acc: "boss", name: "老闆", perms: [13], strategy: "default", mcp: false, chk: 1 });
    const raw = res.headers.getSetCookie().find((c) => c.startsWith("sw_profile="))!.split(";")[0].slice("sw_profile=".length);
    expect(JSON.parse(decodeURIComponent(raw)).name).toBe("老闆");
  });
});
