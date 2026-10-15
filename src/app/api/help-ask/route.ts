import { NextRequest, NextResponse } from "next/server";
import { answerHelpQuestion } from "@/lib/help/helpAnswer";
import type { ChatTurn } from "@/lib/ai/types";

export const maxDuration = 60;

const MAX_QUESTION = 300;

/** 教學助手：POST { question, history? } → { answer, usedAi, model?, sections }。登入即可（不需要「AI 問答」權限，見 permissions.ts）。 */
export async function POST(req: NextRequest) {
  let body: { question?: unknown; history?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "問題不可為空" }, { status: 400 });
  if (question.length > MAX_QUESTION) return NextResponse.json({ error: `問題過長，請控制在 ${MAX_QUESTION} 字以內` }, { status: 400 });
  const history: ChatTurn[] = Array.isArray(body.history)
    ? body.history
        .filter((t): t is ChatTurn => !!t && typeof t === "object" && ((t as ChatTurn).role === "user" || (t as ChatTurn).role === "assistant") && typeof (t as ChatTurn).content === "string")
        .slice(-6)
        .map((t) => ({ role: t.role, content: t.content.slice(0, 1500) }))
    : [];
  try {
    return NextResponse.json(await answerHelpQuestion(question, history));
  } catch (err) {
    console.error("[help-ask] failed:", err);
    return NextResponse.json({ error: "教學助手暫時無法使用，請稍後再試，或到「📖 操作手冊」自己查" }, { status: 503 });
  }
}
