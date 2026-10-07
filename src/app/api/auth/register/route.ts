import { NextResponse, type NextRequest } from "next/server";
import { register } from "@/lib/auth/accounts";
import { authErrorResponse, readJson } from "@/lib/auth/server";

/** 登入頁「申請帳號」：建立待審核帳號，管理員核准後才能登入。 */
export async function POST(req: NextRequest) {
  const b = await readJson<Record<string, unknown>>(req);
  try {
    const message = await register({
      account: String(b?.account ?? ""),
      name: String(b?.name ?? ""),
      password: String(b?.password ?? ""),
      contact: String(b?.contact ?? ""),
    });
    return NextResponse.json({ ok: true, message });
  } catch (err) {
    return authErrorResponse(err);
  }
}
