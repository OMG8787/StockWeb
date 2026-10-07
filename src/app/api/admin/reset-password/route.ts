import { NextResponse, type NextRequest } from "next/server";
import { resetUserPassword } from "@/lib/auth/accounts";
import { authErrorResponse, readJson, sessionFrom } from "@/lib/auth/server";

export async function POST(req: NextRequest) {
  const session = sessionFrom(req);
  if (!session) return NextResponse.json({ error: "未登入" }, { status: 401 });
  const body = await readJson<{ userId?: string }>(req);
  try {
    return NextResponse.json(await resetUserPassword(session, String(body?.userId ?? "")));
  } catch (err) {
    return authErrorResponse(err);
  }
}
