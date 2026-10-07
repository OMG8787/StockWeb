import { NextResponse, type NextRequest } from "next/server";
import { logout } from "@/lib/auth/accounts";
import { sessionFrom } from "@/lib/auth/server";
import { clearSessionCookies } from "@/lib/auth/sessionCookie";

export async function POST(req: NextRequest) {
  const session = sessionFrom(req);
  // 試算表連不上也照樣清掉 cookie：使用者按登出就一定要登出
  if (session) await logout(session).catch((err) => console.warn("[logout]", err));
  const res = NextResponse.json({ ok: true });
  clearSessionCookies(res);
  return res;
}
