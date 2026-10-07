import { NextResponse, type NextRequest } from "next/server";
import { changePassword } from "@/lib/auth/accounts";
import { authErrorResponse, readJson, sessionFrom } from "@/lib/auth/server";
import { writeSessionCookies } from "@/lib/auth/sessionCookie";

export async function POST(req: NextRequest) {
  const session = sessionFrom(req);
  if (!session) return NextResponse.json({ error: "未登入" }, { status: 401 });
  const body = await readJson<{ oldPassword?: unknown; newPassword?: unknown }>(req);
  try {
    const next = await changePassword(session, String(body?.oldPassword ?? ""), String(body?.newPassword ?? ""));
    const res = NextResponse.json({ ok: true });
    writeSessionCookies(res, next);
    return res;
  } catch (err) {
    return authErrorResponse(err);
  }
}
