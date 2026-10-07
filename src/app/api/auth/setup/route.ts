import { NextResponse, type NextRequest } from "next/server";
import { hasAnyUser, setupCodeRequired, setupFirstAdmin } from "@/lib/auth/accounts";
import { authErrorResponse, clientInfo, readJson } from "@/lib/auth/server";
import { writeSessionCookies } from "@/lib/auth/sessionCookie";

/** 試算表還沒有任何帳號時，登入頁會改成「建立第一個管理員」。 */
export async function GET() {
  try {
    return NextResponse.json({ needsSetup: !(await hasAnyUser()), codeRequired: setupCodeRequired() });
  } catch (err) {
    return authErrorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  const b = await readJson<Record<string, unknown>>(req);
  try {
    const session = await setupFirstAdmin(
      { account: String(b?.account ?? ""), name: String(b?.name ?? ""), password: String(b?.password ?? ""), code: String(b?.code ?? "") },
      clientInfo(req),
    );
    const res = NextResponse.json({ ok: true });
    writeSessionCookies(res, session);
    return res;
  } catch (err) {
    return authErrorResponse(err);
  }
}
