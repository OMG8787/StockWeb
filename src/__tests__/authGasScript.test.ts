import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminOverview, createUser, kick, login, revalidate, setupFirstAdmin, updateUser } from "@/lib/auth/accounts";
import { getStore, setStoreForTests } from "@/lib/auth/store";
import { PERM } from "@/lib/auth/permissions";

/**
 * 在 Node 裡模擬 Google 試算表，直接執行 gas/Code.gs，再讓正式環境用的 GasStore
 * （透過攔截 fetch）跑完整帳號流程——使用者還沒建試算表之前，就能確認
 * Apps Script 與 Next.js 兩邊對得起來。
 */

type Cell = string;

class FakeRange {
  constructor(private sheet: FakeSheet, private r: number, private c: number, private nr: number, private nc: number) {}
  getValues(): Cell[][] {
    return Array.from({ length: this.nr }, (_, i) => Array.from({ length: this.nc }, (_, j) => this.sheet.get(this.r + i, this.c + j)));
  }
  getDisplayValues() {
    return this.getValues();
  }
  setValues(v: unknown[][]) {
    v.forEach((row, i) => row.forEach((x, j) => this.sheet.set(this.r + i, this.c + j, String(x))));
    return this;
  }
  setNumberFormat() {
    return this;
  }
  setFontWeight() {
    return this;
  }
  setBackground() {
    return this;
  }
  setNote() {
    return this;
  }
}

class FakeSheet {
  rows: Cell[][] = [];
  maxCols = 26;
  constructor(public name: string) {}
  get(r: number, c: number) {
    return this.rows[r - 1]?.[c - 1] ?? "";
  }
  set(r: number, c: number, v: string) {
    while (this.rows.length < r) this.rows.push([]);
    this.rows[r - 1][c - 1] = v;
  }
  getName() {
    return this.name;
  }
  getLastRow() {
    return this.rows.length;
  }
  getLastColumn() {
    return this.rows.reduce((m, r) => Math.max(m, r.length), 0);
  }
  getMaxColumns() {
    return this.maxCols;
  }
  getMaxRows() {
    return 1000;
  }
  insertColumnsAfter(_after: number, n: number) {
    this.maxCols += n;
  }
  getRange(a: number | string, c = 1, nr = 1, nc = 1) {
    if (typeof a === "string") return new FakeRange(this, 1, 1, 1, 1);
    return new FakeRange(this, a, c, nr, nc);
  }
  appendRow(v: string[]) {
    this.rows.push(v.map(String));
  }
  deleteRow(r: number) {
    this.rows.splice(r - 1, 1);
  }
  deleteRows(r: number, n: number) {
    this.rows.splice(r - 1, n);
  }
  setFrozenRows() {}
}

function loadGas() {
  const sheets: FakeSheet[] = [new FakeSheet("工作表1")];
  const props = new Map<string, string>();
  const ss = {
    getSheetByName: (n: string) => sheets.find((s) => s.name === n) ?? null,
    insertSheet: (n: string) => {
      const s = new FakeSheet(n);
      sheets.push(s);
      return s;
    },
    getSheets: () => [...sheets],
    deleteSheet: (s: FakeSheet) => sheets.splice(sheets.indexOf(s), 1),
  };
  const ctx = vm.createContext({
    console: { log: () => {}, error: () => {}, warn: () => {} },
    SpreadsheetApp: { getActive: () => ss, flush: () => {} },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => props.set(k, v) }),
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    ContentService: { createTextOutput: (t: string) => ({ setMimeType: () => t }), MimeType: { JSON: "json" } },
    Utilities: { getUuid: () => crypto.randomUUID() },
  });
  vm.runInContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../gas/Code.gs"), "utf8"), ctx);
  const gas = ctx as unknown as { setup(): void; doPost(e: unknown): string; doGet(): string };
  gas.setup();
  return { gas, sheets, secret: props.get("API_SECRET")! };
}

const info = { device: "測試", userAgent: "vitest", ip: "1.1.1.1" };

describe("gas/Code.gs ＋ GasStore 整合", () => {
  let env: ReturnType<typeof loadGas>;

  beforeEach(() => {
    env = loadGas();
    vi.stubEnv("AUTH_GAS_URL", "https://script.google.com/macros/s/test/exec");
    vi.stubEnv("AUTH_GAS_SECRET", env.secret);
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const text = env.gas.doPost({ postData: { contents: init.body } });
      return new Response(text, { status: 200 });
    });
    setStoreForTests(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    setStoreForTests(null);
  });

  it("setup 建立三張表、刪掉空白預設工作表、產生 API_SECRET", () => {
    expect(env.sheets.map((s) => s.name).sort()).toEqual(["LoginLog", "Sessions", "Users"]);
    expect(env.secret).toMatch(/^[0-9a-f-]{60,}$/);
    expect(env.sheets.find((s) => s.name === "Users")!.rows[0]).toContain("PasswordHash");
  });

  it("金鑰錯誤一律拒絕", () => {
    const out = JSON.parse(env.gas.doPost({ postData: { contents: JSON.stringify({ secret: "wrong", ops: [{ op: "read", table: "Users" }] }) } }));
    expect(out).toMatchObject({ success: false, code: "AUTH" });
    const bad = JSON.parse(env.gas.doPost({ postData: { contents: JSON.stringify({ secret: env.secret, ops: [{ op: "read", table: "Hack" }] }) } }));
    expect(bad.success).toBe(false);
  });

  it("透過試算表跑完整流程：建管理員、開帳號、登入、改權限、停用、強制登出", async () => {
    expect(getStore().kind).toBe("gas");
    const admin = await setupFirstAdmin({ account: "0050boss", name: "老闆", password: "boss-pass-1", code: "" }, info);
    // 帳號以純文字存，開頭 0 不會被吃掉
    expect(env.sheets.find((s) => s.name === "Users")!.rows[1][1]).toBe("0050boss");

    const { user, tempPassword } = await createUser(admin, { account: "amy", name: "艾咪", perms: [PERM.MARKET], strategy: "swing" });
    const s = await login("amy", tempPassword, info);
    expect(s.perms).toEqual([PERM.MARKET]);

    await updateUser(admin, user.userId, { perms: [PERM.MARKET, PERM.AI_CHAT] });
    const r = await revalidate(s);
    expect(r.payload?.perms).toEqual([PERM.MARKET, PERM.AI_CHAT]);
    await r.touch?.();

    const ov = await adminOverview(admin);
    expect(ov.users.find((u) => u.account === "amy")).toMatchObject({ name: "艾咪", online: true, sessionCount: 1, strategy: "swing" });
    expect(ov.loginLog.length).toBe(2);

    expect(await kick(admin, { userId: user.userId })).toBe(1);
    expect((await revalidate(s)).payload).toBeNull();
    const log = (await adminOverview(admin)).loginLog.find((l) => l.account === "amy")!;
    expect(log.endReason).toMatch(/^強制登出/);

    await updateUser(admin, user.userId, { isActive: false });
    await expect(login("amy", tempPassword, info)).rejects.toThrow("停用");
  });
});
