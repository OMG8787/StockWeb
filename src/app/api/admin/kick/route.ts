import { NextResponse, type NextRequest } from "next/server";
import { kick } from "@/lib/auth/accounts";
import { authErrorResponse, readJson, sessionFrom } from "@/lib/auth/server";

/** 強制登出：{ sessionId } 登出單一裝置；{ userId } 登出該帳號全部裝置。 */
export async function POST(req: NextRequest) {
  const session = sessionFrom(req);
  if (!session) return NextResponse.json({ error: "未登入" }, { status: 401 });
  const body = await readJson<{ sessionId?: string; userId?: string }>(req);
  if (!body?.sessionId && !body?.userId) return NextResponse.json({ error: "缺少對象" }, { status: 400 });
  try {
    return NextResponse.json({ count: await kick(session, { sessionId: body.sessionId, userId: body.userId }) });
  } catch (err) {
    return authErrorResponse(err);
  }
}
