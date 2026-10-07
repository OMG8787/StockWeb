import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { hasPerm, routeAccess } from "@/lib/auth/permissions";
import {
  SESSION_COOKIE,
  clearSessionCookies,
  decodeSession,
  writeSessionCookies,
} from "@/lib/auth/sessionCookie";
import { kvFromRedis, refreshSession } from "@/lib/auth/sessionRefresh";
import { redis } from "@/lib/data/kv";

const authKv = kvFromRedis(redis);

// 帳號制門禁（2026-10-07 起取代原本的共用密碼）：每個人用自己的帳號登入，
// 依帳號權限決定能用哪些功能。網址需要哪個權限只寫在 lib/auth/permissions.ts。
// 本站仍是只給特定人使用的私人工具（AI 會給出明確買賣建議，不能對公眾開放）。

function isApi(pathname: string) {
  return pathname.startsWith("/api/");
}

function toLogin(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (isApi(pathname)) return NextResponse.json({ error: "未登入或登入已失效" }, { status: 401 });
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  const next = pathname + search;
  url.search = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(url);
}

function toAccount(request: NextRequest, query: string, apiError: string, status: number): NextResponse {
  if (isApi(request.nextUrl.pathname)) return NextResponse.json({ error: apiError }, { status });
  const url = request.nextUrl.clone();
  url.pathname = "/account";
  url.search = query;
  return NextResponse.redirect(url);
}

/** 本機腳本（scripts/*.py、backtest、eval）用的服務金鑰：可讀一般功能，不能進管理頁。 */
function isServiceRequest(request: NextRequest): boolean {
  const key = process.env.SERVICE_API_KEY;
  if (!key || key.length < 24) return false;
  return request.headers.get("authorization") === `Bearer ${key}`;
}

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  const { pathname } = request.nextUrl;
  const access = routeAccess(pathname);
  if (access.kind === "public") {
    // 已登入（這台裝置記住了）的人打開登入頁，直接回首頁
    if (pathname === "/login" && decodeSession(request.cookies.get(SESSION_COOKIE)?.value)) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (isServiceRequest(request) && !pathname.startsWith("/admin") && !pathname.startsWith("/api/admin")) {
    return NextResponse.next();
  }

  let session = decodeSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return toLogin(request);

  // 每 5 分鐘回試算表確認一次登入（有 Redis 時在背景進行，不拖慢換頁；見 sessionRefresh.ts）
  const outcome = await refreshSession(session, authKv, (p) => event.waitUntil(p));
  if (outcome.kind === "revoked") {
    const res = toLogin(request);
    clearSessionCookies(res);
    return res;
  }
  const refreshed = outcome.kind === "refresh";
  if (outcome.kind === "refresh") session = outcome.session;

  let res: NextResponse;
  if (session.mcp && pathname !== "/account" && !pathname.startsWith("/api/auth/")) {
    res = toAccount(request, "?force=1", "請先變更臨時密碼", 403);
  } else if (!hasPerm(session.perms, access.need)) {
    res = toAccount(request, `?denied=${encodeURIComponent(pathname)}`, "這個帳號沒有使用此功能的權限", 403);
  } else {
    res = NextResponse.next();
  }
  if (refreshed) writeSessionCookies(res, session);
  return res;
}

export const config = {
  // api/cron/* 由 Vercel Cron 與 GitHub Actions 呼叫（沒有登入），各自檢查 CRON_SECRET。
  matcher: ["/((?!api/cron|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.svg$).*)"],
};
