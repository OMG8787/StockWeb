import { NextResponse, type NextRequest } from "next/server";
import { AuthError, deviceName, type ClientInfo } from "./accounts";
import { decodeSession, SESSION_COOKIE, type SessionPayload } from "./sessionCookie";
import { StoreUnavailableError } from "./store";

/** API route 讀目前登入者（proxy 已經驗證過並在 5 分鐘內回試算表確認過）。 */
export function sessionFrom(req: NextRequest): SessionPayload | null {
  return decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
}

export function clientInfo(req: NextRequest): ClientInfo {
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 300);
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim().slice(0, 60);
  return { device: deviceName(ua), userAgent: ua, ip };
}

/** 帳號相關 API 共用的錯誤回應：AuthError 回對應狀態碼，資料庫連不上回 503。 */
export function authErrorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof StoreUnavailableError) return NextResponse.json({ error: err.message }, { status: 503 });
  console.error("[auth]", err);
  return NextResponse.json({ error: "系統錯誤，請稍後再試" }, { status: 500 });
}

/** 讀 JSON body；格式錯誤回 null。 */
export async function readJson<T>(req: NextRequest): Promise<T | null> {
  return (await req.json().catch(() => null)) as T | null;
}
