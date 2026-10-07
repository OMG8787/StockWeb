import { NextResponse, type NextRequest } from "next/server";
import { requestPasswordReset } from "@/lib/auth/accounts";
import { authErrorResponse, readJson } from "@/lib/auth/server";

/** 登入頁「忘記密碼」：送出重設申請給管理員（不論資料對不對都回同一句話）。 */
export async function POST(req: NextRequest) {
  const b = await readJson<Record<string, unknown>>(req);
  try {
    const message = await requestPasswordReset(String(b?.account ?? ""), String(b?.contact ?? ""));
    return NextResponse.json({ ok: true, message });
  } catch (err) {
    return authErrorResponse(err);
  }
}
