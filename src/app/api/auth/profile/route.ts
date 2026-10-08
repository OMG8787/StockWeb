import { NextResponse, type NextRequest } from "next/server";
import { updateOwnName } from "@/lib/auth/accounts";
import { authErrorResponse, readJson, sessionFrom } from "@/lib/auth/server";
import { writeSessionCookies } from "@/lib/auth/sessionCookie";

/** 使用者自己改顯示名稱：{ name }；改完重寫登入 cookie，畫面上的名字立刻換掉 */
export async function POST(req: NextRequest) {
  const session = sessionFrom(req);
  if (!session) return NextResponse.json({ error: "未登入" }, { status: 401 });
  const body = await readJson<{ name?: unknown }>(req);
  try {
    const next = await updateOwnName(session, String(body?.name ?? ""));
    const res = NextResponse.json({ ok: true, name: next.name });
    writeSessionCookies(res, next);
    return res;
  } catch (err) {
    return authErrorResponse(err);
  }
}
