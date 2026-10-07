import { NextResponse, type NextRequest } from "next/server";
import { reviewUser } from "@/lib/auth/accounts";
import { authErrorResponse, readJson, sessionFrom } from "@/lib/auth/server";

/** 審核自行申請的帳號：{ userId, decision: "approve" | "reject", perms?, strategy? } */
export async function POST(req: NextRequest) {
  const session = sessionFrom(req);
  if (!session) return NextResponse.json({ error: "未登入" }, { status: 401 });
  const b = await readJson<{ userId?: string; decision?: string; perms?: number[]; strategy?: string }>(req);
  if (b?.decision !== "approve" && b?.decision !== "reject") return NextResponse.json({ error: "decision 必須是 approve 或 reject" }, { status: 400 });
  try {
    return NextResponse.json({ user: await reviewUser(session, String(b.userId ?? ""), b.decision, { perms: b.perms, strategy: b.strategy }) });
  } catch (err) {
    return authErrorResponse(err);
  }
}
