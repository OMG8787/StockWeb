import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parsePerms, type PermCode } from "./permissions";

/**
 * 登入 cookie：`sw_session` 存「隨機登入憑證＋使用者資料」並用 AUTH_SECRET 簽章，
 * proxy 每次請求只驗簽章（不用每次都去試算表查），每 REVALIDATE_MS 才回試算表
 * 確認這個登入還在、帳號沒被停用、權限有沒有改。管理員強制登出／停用帳號後，
 * 最慢 REVALIDATE_MS 內生效。
 *
 * `sw_profile` 是給畫面用的（名稱、權限，讓導覽列決定顯示哪些選單），不是安全邊界：
 * 被竄改也只影響畫面，實際的擋法一律以簽過章的 sw_session 為準。
 */
export const SESSION_COOKIE = "sw_session";
export const PROFILE_COOKIE = "sw_profile";
export const SESSION_MAX_AGE_DAYS = 180;
export const REVALIDATE_MS = 5 * 60 * 1000;

export interface SessionPayload {
  /** 登入憑證（原文；試算表只存雜湊） */
  t: string;
  /** SessionId（對應試算表 Sessions / LoginLog） */
  sid: string;
  uid: string;
  acc: string;
  name: string;
  perms: PermCode[];
  strategy: string;
  /** 臨時密碼，必須先改密碼 */
  mcp: boolean;
  /** 上次回試算表確認的時間（毫秒） */
  chk: number;
}

export interface ProfileCookie {
  name: string;
  account: string;
  perms: PermCode[];
  strategy: string;
  mustChangePassword: boolean;
}

const DEV_SECRET = "stockweb-dev-only-secret-do-not-use-in-production";

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET 未設定（至少 16 字元）");
  return DEV_SECRET;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

export function encodeSession(payload: SessionPayload): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function decodeSession(value: string | undefined): SessionPayload | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const mac = Buffer.from(value.slice(dot + 1));
  let expected: Buffer;
  try {
    expected = Buffer.from(sign(body));
  } catch {
    return null;
  }
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof p.t !== "string" || typeof p.uid !== "string" || typeof p.chk !== "number") return null;
    return { ...p, perms: parsePerms(p.perms) };
  } catch {
    return null;
  }
}

export function profileOf(p: SessionPayload): ProfileCookie {
  return { name: p.name, account: p.acc, perms: p.perms, strategy: p.strategy, mustChangePassword: p.mcp };
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update("sw-session:" + token).digest("hex");
}

/** 寫入兩個 cookie 用的共同設定（NextResponse.cookies.set 的第三個參數） */
export function cookieOptions(httpOnly: boolean) {
  return {
    httpOnly,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_DAYS * 24 * 60 * 60,
  };
}

interface CookieWriter {
  cookies: { set(name: string, value: string, opts: ReturnType<typeof cookieOptions>): unknown };
}

export function writeSessionCookies(res: CookieWriter, payload: SessionPayload): void {
  res.cookies.set(SESSION_COOKIE, encodeSession(payload), cookieOptions(true));
  // 不要自己 encodeURIComponent：cookies.set 會再編碼一次，前端只解一次就會解析失敗
  res.cookies.set(PROFILE_COOKIE, JSON.stringify(profileOf(payload)), cookieOptions(false));
}

export function clearSessionCookies(res: CookieWriter): void {
  const gone = { ...cookieOptions(true), maxAge: 0 };
  res.cookies.set(SESSION_COOKIE, "", gone);
  res.cookies.set(PROFILE_COOKIE, "", { ...gone, httpOnly: false });
}
