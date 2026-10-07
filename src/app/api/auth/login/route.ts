import { NextResponse, type NextRequest } from "next/server";
import { login } from "@/lib/auth/accounts";
import { authErrorResponse, clientInfo, readJson } from "@/lib/auth/server";
import { writeSessionCookies } from "@/lib/auth/sessionCookie";

export async function POST(req: NextRequest) {
  const body = await readJson<{ account?: unknown; password?: unknown }>(req);
  try {
    const session = await login(String(body?.account ?? ""), String(body?.password ?? ""), clientInfo(req));
    const res = NextResponse.json({ ok: true, mustChangePassword: session.mcp });
    writeSessionCookies(res, session);
    return res;
  } catch (err) {
    return authErrorResponse(err);
  }
}
