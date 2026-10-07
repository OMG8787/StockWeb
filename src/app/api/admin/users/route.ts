import { NextResponse, type NextRequest } from "next/server";
import { adminOverview, createUser, updateUser, type UserInput } from "@/lib/auth/accounts";
import { authErrorResponse, readJson, sessionFrom } from "@/lib/auth/server";

// 帳號與權限管理（proxy 已擋下沒有「系統管理」權限的人；accounts.ts 會再用試算表裡的最新權限確認一次）

export async function GET(req: NextRequest) {
  const session = sessionFrom(req);
  if (!session) return NextResponse.json({ error: "未登入" }, { status: 401 });
  try {
    return NextResponse.json(await adminOverview(session));
  } catch (err) {
    return authErrorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  const session = sessionFrom(req);
  if (!session) return NextResponse.json({ error: "未登入" }, { status: 401 });
  const body = await readJson<UserInput>(req);
  try {
    return NextResponse.json(await createUser(session, body ?? {}));
  } catch (err) {
    return authErrorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
  const session = sessionFrom(req);
  if (!session) return NextResponse.json({ error: "未登入" }, { status: 401 });
  const body = await readJson<UserInput & { userId?: string }>(req);
  try {
    const { userId, ...input } = body ?? {};
    return NextResponse.json({ user: await updateUser(session, String(userId ?? ""), input) });
  } catch (err) {
    return authErrorResponse(err);
  }
}
