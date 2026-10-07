import { randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { getStore, type Row, type StoreOp } from "./store";
import {
  DEFAULT_STRATEGY,
  PERM,
  PERMISSION_LIST,
  STRATEGIES,
  formatPerms,
  hasPerm,
  parsePerms,
  type PermCode,
} from "./permissions";
import { hashToken, newToken, type SessionPayload } from "./sessionCookie";
import { MIN_PASSWORD_LENGTH_CLIENT } from "./clientConstants";

/**
 * 帳號規則（登入、登出、驗證登入、改密碼、管理員管理帳號）。
 * 儲存一律走 store.ts 的通用表格操作，正式＝Google 試算表、本機＝JSON 檔。
 */

export class AuthError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const ONLINE_MINUTES = 15;
const LOGIN_LOG_KEEP = 3000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MIN = 15;
export const MIN_PASSWORD_LENGTH = MIN_PASSWORD_LENGTH_CLIENT;

// ---------- 時間：試算表裡存台北時間「YYYY-MM-DD HH:mm:ss」，人眼好讀 ----------
export function taipeiNow(date = new Date()): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
}

export function parseTaipei(s: string | undefined): number {
  if (!s) return NaN;
  return Date.parse(s.replace(" ", "T") + "+08:00");
}

// ---------- 密碼 ----------
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, saltB64, hashB64] = String(stored || "").split("$");
  if (kind !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

function assertPasswordStrength(pw: string): void {
  if (pw.length < MIN_PASSWORD_LENGTH) throw new AuthError(`密碼至少 ${MIN_PASSWORD_LENGTH} 個字元`);
  if (pw.length > 200) throw new AuthError("密碼太長");
}

/** 臨時密碼：去掉容易看錯的字（0/O、1/l/I） */
export function tempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += chars[randomInt(chars.length)];
  return out;
}

// ---------- 資料轉換 ----------
export interface User {
  userId: string;
  account: string;
  name: string;
  perms: PermCode[];
  strategy: string;
  isActive: boolean;
  mustChangePassword: boolean;
  note: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string;
}

const bool = (v: string | undefined) => String(v ?? "").trim().toUpperCase() === "TRUE";

function toUser(r: Row): User {
  return {
    userId: r.UserId,
    account: r.Account ?? "",
    name: r.Name ?? "",
    perms: parsePerms(r.Permissions),
    strategy: STRATEGIES.some((s) => s.id === r.Strategy) ? r.Strategy : DEFAULT_STRATEGY,
    // 空白當作啟用：在試算表手動新增列時不用每格都填
    isActive: (r.IsActive ?? "").trim() === "" ? true : bool(r.IsActive),
    mustChangePassword: bool(r.MustChangePassword),
    note: r.Note ?? "",
    createdAt: r.CreatedAt ?? "",
    updatedAt: r.UpdatedAt ?? "",
    lastLoginAt: r.LastLoginAt ?? "",
  };
}

const normAccount = (s: string) => s.trim().toLowerCase();

function cleanText(v: unknown, max: number): string {
  return String(v ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

async function readTables(...tables: Array<"Users" | "Sessions" | "LoginLog">): Promise<Row[][]> {
  return (await getStore().batch(tables.map((table) => ({ op: "read" as const, table })))) as Row[][];
}

function sessionPayload(user: User, token: string, sessionId: string): SessionPayload {
  return {
    t: token,
    sid: sessionId,
    uid: user.userId,
    acc: user.account,
    name: user.name,
    perms: user.perms,
    strategy: user.strategy,
    mcp: user.mustChangePassword,
    chk: Date.now(),
  };
}

export interface ClientInfo {
  device: string;
  userAgent: string;
  ip: string;
}

/** 從 User-Agent 推一個好讀的裝置名稱（管理頁顯示用） */
export function deviceName(ua: string): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" :
    /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "其他裝置";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" :
    /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${os}・${browser}` : os;
}

function newSessionOps(user: User, info: ClientInfo, token: string, sessionId: string, now: string): StoreOp[] {
  return [
    {
      op: "append",
      table: "Sessions",
      row: {
        SessionId: sessionId, TokenHash: hashToken(token), UserId: user.userId, Account: user.account, Name: user.name,
        Device: info.device, UserAgent: info.userAgent, LoginAt: now, LastActiveAt: now,
      },
    },
    {
      op: "append",
      table: "LoginLog",
      row: {
        ID: sessionId, LoginAt: now, UserId: user.userId, Account: user.account, Name: user.name, Result: "成功",
        Device: info.device, UserAgent: info.userAgent, Ip: info.ip, LastActiveAt: now, EndAt: "", EndReason: "",
      },
    },
    { op: "update", table: "Users", key: user.userId, patch: { LastLoginAt: now } },
    { op: "trim", table: "LoginLog", keep: LOGIN_LOG_KEEP },
  ];
}

function endSessionOps(sessionRow: Row, reason: string, now: string): StoreOp[] {
  return [
    { op: "delete", table: "Sessions", key: sessionRow.SessionId },
    { op: "update", table: "LoginLog", key: sessionRow.SessionId, patch: { EndAt: now, EndReason: reason } },
  ];
}

// ============================================================
// 登入／登出／驗證
// ============================================================

export async function login(accountRaw: string, password: string, info: ClientInfo): Promise<SessionPayload> {
  const account = cleanText(accountRaw, 60);
  if (!account || !password) throw new AuthError("請輸入帳號與密碼");

  const [userRows, logRows] = await readTables("Users", "LoginLog");
  const row = userRows.find((r) => normAccount(r.Account ?? "") === normAccount(account));
  const user = row ? toUser(row) : null;
  const now = taipeiNow();

  // 同一帳號短時間內連續失敗太多次：先擋下（避免被暴力猜密碼）
  const since = Date.now() - FAIL_WINDOW_MIN * 60_000;
  const recentFails = logRows.filter(
    (r) => normAccount(r.Account ?? "") === normAccount(account) && (r.Result ?? "").startsWith("失敗") && parseTaipei(r.LoginAt) >= since,
  ).length;

  const reject = async (message: string, status = 401): Promise<never> => {
    await getStore().batch([
      {
        op: "append",
        table: "LoginLog",
        row: {
          ID: "F" + randomUUID().replace(/-/g, "").slice(0, 16), LoginAt: now, UserId: user?.userId ?? "", Account: account,
          Name: user?.name ?? "", Result: "失敗：" + message, Device: info.device, UserAgent: info.userAgent, Ip: info.ip,
        },
      },
      { op: "trim", table: "LoginLog", keep: LOGIN_LOG_KEEP },
    ]);
    throw new AuthError(message === "帳號不存在" || message === "密碼錯誤" ? "帳號或密碼錯誤" : message, status);
  };

  if (recentFails >= MAX_FAILS) return reject(`嘗試次數過多，請 ${FAIL_WINDOW_MIN} 分鐘後再試`, 429);
  if (!user || !row) return reject("帳號不存在");
  if (!verifyPassword(password, row.PasswordHash ?? "")) return reject("密碼錯誤");
  if (!user.isActive) return reject("帳號已停用，請聯絡管理員", 403);

  const token = newToken();
  const sessionId = "S" + randomUUID().replace(/-/g, "").slice(0, 20);
  await getStore().batch(newSessionOps(user, info, token, sessionId, now));
  return sessionPayload(user, token, sessionId);
}

export async function logout(p: SessionPayload): Promise<void> {
  const [sessions] = await readTables("Sessions");
  const s = sessions.find((r) => r.SessionId === p.sid && r.TokenHash === hashToken(p.t));
  if (s) await getStore().batch(endSessionOps(s, "登出", taipeiNow()));
}

/**
 * 回試算表確認登入仍有效，並帶回最新的權限／名稱／策略。
 * 回傳 null＝登入已失效（被強制登出、帳號停用或刪除），呼叫端要清掉 cookie。
 * touch：要寫入「最後活動時間」的背景工作（呼叫端用 waitUntil 執行，不拖慢回應）。
 */
export async function revalidate(p: SessionPayload): Promise<{ payload: SessionPayload | null; touch?: () => Promise<unknown> }> {
  const [sessions, users] = await readTables("Sessions", "Users");
  const s = sessions.find((r) => r.SessionId === p.sid && r.TokenHash === hashToken(p.t));
  if (!s) return { payload: null };
  const row = users.find((r) => r.UserId === s.UserId);
  const now = taipeiNow();
  if (!row || !toUser(row).isActive) {
    return { payload: null, touch: () => getStore().batch(endSessionOps(s, row ? "帳號停用" : "帳號已刪除", now)) };
  }
  const user = toUser(row);
  return {
    payload: sessionPayload(user, p.t, p.sid),
    touch: () =>
      getStore().batch([
        { op: "update", table: "Sessions", key: s.SessionId, patch: { LastActiveAt: now, Name: user.name } },
        { op: "update", table: "LoginLog", key: s.SessionId, patch: { LastActiveAt: now } },
      ]),
  };
}

export async function changePassword(p: SessionPayload, oldPw: string, newPw: string): Promise<SessionPayload> {
  assertPasswordStrength(newPw);
  if (oldPw === newPw) throw new AuthError("新密碼不能跟舊密碼相同");
  const [users, sessions] = await readTables("Users", "Sessions");
  const row = users.find((r) => r.UserId === p.uid);
  if (!row) throw new AuthError("查無帳號", 404);
  if (!verifyPassword(oldPw, row.PasswordHash ?? "")) throw new AuthError("目前的密碼不正確", 401);
  const now = taipeiNow();
  // 改密碼後，其他裝置的登入一律結束
  const others = sessions.filter((r) => r.UserId === p.uid && r.SessionId !== p.sid);
  await getStore().batch([
    { op: "update", table: "Users", key: p.uid, patch: { PasswordHash: hashPassword(newPw), MustChangePassword: "FALSE", UpdatedAt: now } },
    ...others.flatMap((s) => endSessionOps(s, "已變更密碼", now)),
  ]);
  return { ...sessionPayload(toUser(row), p.t, p.sid), mcp: false };
}

// ============================================================
// 第一個管理員（試算表還沒有任何帳號時）
// ============================================================

export async function hasAnyUser(): Promise<boolean> {
  const [users] = await readTables("Users");
  return users.length > 0;
}

export function setupCodeRequired(): boolean {
  return process.env.NODE_ENV === "production" || Boolean(process.env.ADMIN_SETUP_CODE);
}

export async function setupFirstAdmin(
  input: { account: string; name: string; password: string; code: string },
  info: ClientInfo,
): Promise<SessionPayload> {
  if (setupCodeRequired()) {
    const code = process.env.ADMIN_SETUP_CODE;
    if (!code) throw new AuthError("伺服器尚未設定 ADMIN_SETUP_CODE，無法建立第一個管理員", 403);
    if (input.code !== code) throw new AuthError("設定碼不正確", 403);
  }
  if (await hasAnyUser()) throw new AuthError("已經有帳號了，請直接登入", 409);
  const account = cleanText(input.account, 60);
  if (!/^[\w.@-]{3,60}$/.test(account)) throw new AuthError("帳號只能用英文、數字、底線、點、@、-，3～60 字");
  assertPasswordStrength(input.password);
  const now = taipeiNow();
  const user: User = {
    userId: "U" + randomUUID().replace(/-/g, "").slice(0, 16),
    account,
    name: cleanText(input.name, 40) || account,
    perms: PERMISSION_LIST.map((x) => x.code),
    strategy: DEFAULT_STRATEGY,
    isActive: true,
    mustChangePassword: false,
    note: "第一個管理員",
    createdAt: now,
    updatedAt: now,
    lastLoginAt: "",
  };
  await getStore().batch([{ op: "append", table: "Users", row: userRow(user, hashPassword(input.password)) }]);
  return login(account, input.password, info);
}

function userRow(u: User, passwordHash: string): Row {
  return {
    UserId: u.userId, Account: u.account, Name: u.name, PasswordHash: passwordHash, Permissions: formatPerms(u.perms),
    Strategy: u.strategy, IsActive: u.isActive ? "TRUE" : "FALSE", MustChangePassword: u.mustChangePassword ? "TRUE" : "FALSE",
    Note: u.note, CreatedAt: u.createdAt, UpdatedAt: u.updatedAt, LastLoginAt: u.lastLoginAt,
  };
}

// ============================================================
// 管理員功能（每次都用試算表裡「目前」的權限判斷，不信任 cookie 裡的舊權限）
// ============================================================

function requireAdmin(users: Row[], actorId: string): User {
  const row = users.find((r) => r.UserId === actorId);
  const actor = row ? toUser(row) : null;
  if (!actor || !actor.isActive || !hasPerm(actor.perms, [PERM.ADMIN])) throw new AuthError("沒有系統管理權限", 403);
  return actor;
}

export interface SessionView {
  sessionId: string;
  userId: string;
  account: string;
  name: string;
  device: string;
  userAgent: string;
  loginAt: string;
  lastActiveAt: string;
  online: boolean;
  isMe: boolean;
}

export interface UserView extends User {
  sessionCount: number;
  online: boolean;
  lastActiveAt: string;
}

function isOnline(lastActiveAt: string): boolean {
  const t = parseTaipei(lastActiveAt);
  return Number.isFinite(t) && Date.now() - t <= ONLINE_MINUTES * 60_000;
}

function toSessionView(r: Row, mySid: string): SessionView {
  return {
    sessionId: r.SessionId, userId: r.UserId, account: r.Account ?? "", name: r.Name ?? "", device: r.Device ?? "",
    userAgent: r.UserAgent ?? "", loginAt: r.LoginAt ?? "", lastActiveAt: r.LastActiveAt ?? "",
    online: isOnline(r.LastActiveAt ?? ""), isMe: r.SessionId === mySid,
  };
}

export async function adminOverview(actor: SessionPayload, logLimit = 300) {
  const [users, sessions, log] = await readTables("Users", "Sessions", "LoginLog");
  requireAdmin(users, actor.uid);
  const sessionViews = sessions.map((r) => toSessionView(r, actor.sid)).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  const userViews: UserView[] = users.map((r) => {
    const u = toUser(r);
    const mine = sessionViews.filter((s) => s.userId === u.userId);
    return {
      ...u,
      sessionCount: mine.length,
      online: mine.some((s) => s.online),
      lastActiveAt: mine[0]?.lastActiveAt ?? "",
    };
  });
  const loginLog = log.slice(-logLimit).reverse().map((r) => ({
    id: r.ID, loginAt: r.LoginAt ?? "", account: r.Account ?? "", name: r.Name ?? "", result: r.Result ?? "",
    device: r.Device ?? "", ip: r.Ip ?? "", lastActiveAt: r.LastActiveAt ?? "", endAt: r.EndAt ?? "", endReason: r.EndReason ?? "",
  }));
  return { users: userViews, sessions: sessionViews, loginLog, onlineMinutes: ONLINE_MINUTES };
}

export interface UserInput {
  account?: string;
  name?: string;
  perms?: number[];
  strategy?: string;
  isActive?: boolean;
  note?: string;
}

/** 只有最高管理員能授予／移除 13；任何人都不能移除自己的管理權限。 */
function assertPermChange(actor: User, targetId: string, oldPerms: PermCode[], newPerms: PermCode[]): void {
  const had13 = oldPerms.includes(PERM.SUPER_ADMIN);
  const has13 = newPerms.includes(PERM.SUPER_ADMIN);
  if (had13 !== has13 && !actor.perms.includes(PERM.SUPER_ADMIN)) throw new AuthError("只有最高管理員能變更「最高管理員」權限", 403);
  if (targetId === actor.userId && !hasPerm(newPerms, [PERM.ADMIN])) throw new AuthError("不能移除自己的管理權限", 400);
}

export async function createUser(actor: SessionPayload, input: UserInput): Promise<{ user: User; tempPassword: string }> {
  const [users] = await readTables("Users");
  const admin = requireAdmin(users, actor.uid);
  const account = cleanText(input.account, 60);
  if (!/^[\w.@-]{3,60}$/.test(account)) throw new AuthError("帳號只能用英文、數字、底線、點、@、-，3～60 字");
  if (users.some((r) => normAccount(r.Account ?? "") === normAccount(account))) throw new AuthError("這個帳號已經存在", 409);
  const perms = parsePerms(input.perms ?? []);
  assertPermChange(admin, "", [], perms);
  const now = taipeiNow();
  const pw = tempPassword();
  const user: User = {
    userId: "U" + randomUUID().replace(/-/g, "").slice(0, 16),
    account,
    name: cleanText(input.name, 40) || account,
    perms,
    strategy: STRATEGIES.some((s) => s.id === input.strategy) ? input.strategy! : DEFAULT_STRATEGY,
    isActive: input.isActive !== false,
    mustChangePassword: true,
    note: cleanText(input.note, 200),
    createdAt: now,
    updatedAt: now,
    lastLoginAt: "",
  };
  await getStore().batch([{ op: "append", table: "Users", row: userRow(user, hashPassword(pw)) }]);
  return { user, tempPassword: pw };
}

export async function updateUser(actor: SessionPayload, userId: string, input: UserInput): Promise<User> {
  const [users, sessions] = await readTables("Users", "Sessions");
  const admin = requireAdmin(users, actor.uid);
  const row = users.find((r) => r.UserId === userId);
  if (!row) throw new AuthError("查無帳號", 404);
  const old = toUser(row);
  const patch: Row = { UpdatedAt: taipeiNow() };
  const next: User = { ...old };

  if (input.name !== undefined) next.name = patch.Name = cleanText(input.name, 40) || old.account;
  if (input.note !== undefined) next.note = patch.Note = cleanText(input.note, 200);
  if (input.strategy !== undefined) {
    if (!STRATEGIES.some((s) => s.id === input.strategy)) throw new AuthError("未知的策略");
    next.strategy = patch.Strategy = input.strategy;
  }
  if (input.perms !== undefined) {
    const perms = parsePerms(input.perms);
    assertPermChange(admin, userId, old.perms, perms);
    next.perms = perms;
    patch.Permissions = formatPerms(perms);
  }
  if (input.isActive !== undefined) {
    if (userId === admin.userId && !input.isActive) throw new AuthError("不能停用自己的帳號");
    if (old.perms.includes(PERM.SUPER_ADMIN) && !admin.perms.includes(PERM.SUPER_ADMIN)) throw new AuthError("不能停用最高管理員", 403);
    next.isActive = input.isActive;
    patch.IsActive = input.isActive ? "TRUE" : "FALSE";
  }

  const ops: StoreOp[] = [{ op: "update", table: "Users", key: userId, patch }];
  if (!next.isActive && old.isActive) {
    const now = taipeiNow();
    for (const s of sessions.filter((r) => r.UserId === userId)) ops.push(...endSessionOps(s, `帳號停用（${admin.name}）`, now));
  }
  await getStore().batch(ops);
  return next;
}

export async function resetUserPassword(actor: SessionPayload, userId: string): Promise<{ tempPassword: string }> {
  const [users, sessions] = await readTables("Users", "Sessions");
  const admin = requireAdmin(users, actor.uid);
  const row = users.find((r) => r.UserId === userId);
  if (!row) throw new AuthError("查無帳號", 404);
  if (userId === admin.userId) throw new AuthError("要改自己的密碼請到「帳號設定」");
  if (toUser(row).perms.includes(PERM.SUPER_ADMIN) && !admin.perms.includes(PERM.SUPER_ADMIN)) {
    throw new AuthError("不能重設最高管理員的密碼", 403);
  }
  const pw = tempPassword();
  const now = taipeiNow();
  await getStore().batch([
    { op: "update", table: "Users", key: userId, patch: { PasswordHash: hashPassword(pw), MustChangePassword: "TRUE", UpdatedAt: now } },
    ...sessions.filter((r) => r.UserId === userId).flatMap((s) => endSessionOps(s, `密碼重設（${admin.name}）`, now)),
  ]);
  return { tempPassword: pw };
}

/** 強制登出：指定 sessionId 只登出那台裝置；指定 userId 登出該帳號所有裝置（自己目前這台除外）。 */
export async function kick(actor: SessionPayload, target: { sessionId?: string; userId?: string }): Promise<number> {
  const [users, sessions] = await readTables("Users", "Sessions");
  const admin = requireAdmin(users, actor.uid);
  const list = target.sessionId
    ? sessions.filter((r) => r.SessionId === target.sessionId)
    : sessions.filter((r) => r.UserId === target.userId && r.SessionId !== actor.sid);
  if (target.sessionId && list[0]?.SessionId === actor.sid) throw new AuthError("不能強制登出自己，請直接按登出");
  if (list.length === 0) return 0;
  const now = taipeiNow();
  await getStore().batch(list.flatMap((s) => endSessionOps(s, `強制登出（${admin.name}）`, now)));
  return list.length;
}
