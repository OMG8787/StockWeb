import { NextRequest, NextResponse } from "next/server";
import { recordModelEvent } from "@/lib/ai/modelStats";
import { authErrorResponse, sessionFrom } from "@/lib/auth/server";
import { isAdmin } from "@/lib/auth/permissions";
import {
  FEEDBACK_KEEP,
  FEEDBACK_VIEWS,
  FeedbackError,
  appendFeedback,
  isFeedbackRating,
  listFeedback,
  updateFeedback,
  type FeedbackEntry,
  type FeedbackUpdate,
  type FeedbackViewFilter,
} from "@/lib/feedbackStore";

/**
 * 使用者回饋：AI 回答的 👍／👎／📝回報，與 AI 面板「🛠 回報網站」（rating＝site）。
 * 2026-10-07 起存在帳號同一份 Google 試算表的 Feedback 分頁（見 lib/feedbackStore.ts），
 * 會記下是哪個帳號回報的。
 *
 * - POST：有「AI 問答」權限的帳號（proxy 擋）；寫入失敗回 503，前端會提示並保留內容。
 * - GET：`/api/ask-feedback?limit=50&rating=down&view=open`，新到舊（view：open 待處理、
 *   review 已完成待確認、confirmed 已確認、all）。只給管理員與本機腳本（服務金鑰）。
 * - PATCH：`{ id, status?, resolveNote?, confirm?, adminNote? }` 更新處理狀態。管理員全部可改；
 *   本機腳本（scripts/resolve-feedback.py）只能標處理狀態與說明，確認一定要管理員。
 */
const MAX_LIMIT = FEEDBACK_KEEP;
const MAX_TEXT = 2000;
const MAX_REASON = 200;
/** 「回報問題／建議」是使用者自由描述（可用語音），比 👎 的一句原因長。 */
const MAX_REPORT = 1000;
const MAX_BODY_CHARS = 20000;

function clip(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

export async function POST(req: NextRequest) {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ error: "格式錯誤" }, { status: 400 });
  }
  if (raw.length > MAX_BODY_CHARS) {
    return NextResponse.json({ error: "內容過長" }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "格式錯誤" }, { status: 400 });
  }
  if (!isFeedbackRating(body.rating)) {
    return NextResponse.json({ error: "rating 必須是 up、down、report 或 site" }, { status: 400 });
  }
  const answer = clip(body.answer, MAX_TEXT);
  if (!answer && body.rating !== "site") {
    return NextResponse.json({ error: "缺少 answer" }, { status: 400 });
  }
  const isFreeText = body.rating === "report" || body.rating === "site";
  const reason = clip(body.reason, isFreeText ? MAX_REPORT : MAX_REASON).trim();
  if (isFreeText && !reason) {
    return NextResponse.json({ error: "回報內容不可空白" }, { status: 400 });
  }
  const symbol = clip(body.symbol, 20).trim();
  const page = clip(body.page, 200).trim();
  const model = clip(body.model, 80).trim();
  const session = sessionFrom(req);
  // at 以伺服器時間為準（客戶端時鐘不可信），客戶端傳的 at 不採用。
  const entry: FeedbackEntry = {
    rating: body.rating,
    question: clip(body.question, MAX_TEXT),
    answer,
    ...(reason ? { reason } : {}),
    ...(symbol ? { symbol } : {}),
    ...(page ? { page } : {}),
    ...(model ? { model } : {}),
    ...(session ? { account: session.acc, name: session.name } : {}),
    at: new Date().toISOString(),
  };

  try {
    await appendFeedback(entry, session?.uid);
  } catch (err) {
    return authErrorResponse(err);
  }
  if (model && body.rating !== "site") recordModelEvent(model, body.rating);
  return NextResponse.json({ ok: true, stored: true });
}

export async function GET(req: NextRequest) {
  // 沒有登入 session＝通過 proxy 的服務金鑰（本機腳本）；有 session 就必須是管理員
  const session = sessionFrom(req);
  if (session && !isAdmin(session.perms)) {
    return NextResponse.json({ error: "只有管理員能查看回饋" }, { status: 403 });
  }
  const limitParam = Number(req.nextUrl.searchParams.get("limit") ?? "50");
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? Math.floor(limitParam) : 50, 1), MAX_LIMIT);
  const rating = req.nextUrl.searchParams.get("rating");
  if (rating !== null && !isFeedbackRating(rating)) {
    return NextResponse.json({ error: "rating 必須是 up、down、report 或 site" }, { status: 400 });
  }
  const view = req.nextUrl.searchParams.get("view") ?? "all";
  if (!(FEEDBACK_VIEWS as readonly string[]).includes(view)) {
    return NextResponse.json({ error: "view 必須是 open、review、confirmed 或 all" }, { status: 400 });
  }
  try {
    const items = await listFeedback(limit, { rating: rating ?? undefined, view: view as FeedbackViewFilter });
    return NextResponse.json({ enabled: true, count: items.length, items });
  } catch (err) {
    return authErrorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
  const session = sessionFrom(req);
  if (session && !isAdmin(session.perms)) {
    return NextResponse.json({ error: "只有管理員能更新回饋狀態" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as (FeedbackUpdate & { id?: unknown }) | null;
  if (!body || typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  const { id, ...input } = body;
  try {
    const item = await updateFeedback(id, input, session ? { name: session.name } : null);
    return NextResponse.json({ item });
  } catch (err) {
    if (err instanceof FeedbackError) return NextResponse.json({ error: err.message }, { status: err.status });
    return authErrorResponse(err);
  }
}
