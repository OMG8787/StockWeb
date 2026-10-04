import { NextRequest, NextResponse } from "next/server";
import { kvEnabled, redis } from "@/lib/data/kv";

/**
 * AI 回答的 👍／👎 回饋，存進 Redis list 供開發者查看（兩個方法都在 src/proxy.ts 密碼閘內）。
 *
 * - POST：使用者真的按了 👍／👎 才會呼叫，一次最多 2 個 Redis 指令（LPUSH + LTRIM，
 *   用 pipeline 合成一次 HTTP 請求）。問答本身（/api/ask）完全不寫任何東西。
 * - GET：`/api/ask-feedback?limit=50&rating=down`（rating 可為 up／down／report），新到舊回傳最近的回饋（1 個 LRANGE）。
 * - 沒有 Redis 時安靜失敗：POST 仍回 ok（前端照常顯示已送出），GET 回空陣列。
 */
const FEEDBACK_KEY = "ask-feedback:v1";
const MAX_ENTRIES = 300;
const MAX_TEXT = 2000;
const MAX_REASON = 200;
/** 「回報問題／建議」是使用者自由描述（可用語音），比 👎 的一句原因長。 */
const MAX_REPORT = 1000;
const RATINGS = ["up", "down", "report"] as const;
type Rating = (typeof RATINGS)[number];
function isRating(v: unknown): v is Rating {
  return typeof v === "string" && (RATINGS as readonly string[]).includes(v);
}
const MAX_BODY_CHARS = 20000;

interface FeedbackEntry {
  rating: Rating;
  question: string;
  answer: string;
  reason?: string;
  symbol?: string;
  at: string;
}

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
  if (!isRating(body.rating)) {
    return NextResponse.json({ error: "rating 必須是 up、down 或 report" }, { status: 400 });
  }
  const answer = clip(body.answer, MAX_TEXT);
  if (!answer) {
    return NextResponse.json({ error: "缺少 answer" }, { status: 400 });
  }
  const reason = clip(body.reason, body.rating === "report" ? MAX_REPORT : MAX_REASON).trim();
  if (body.rating === "report" && !reason) {
    return NextResponse.json({ error: "回報內容不可空白" }, { status: 400 });
  }
  const symbol = clip(body.symbol, 20).trim();
  // at 以伺服器時間為準（客戶端時鐘不可信），客戶端傳的 at 不採用。
  const entry: FeedbackEntry = {
    rating: body.rating,
    question: clip(body.question, MAX_TEXT),
    answer,
    ...(reason ? { reason } : {}),
    ...(symbol ? { symbol } : {}),
    at: new Date().toISOString(),
  };

  if (redis) {
    try {
      await redis.pipeline().lpush(FEEDBACK_KEY, JSON.stringify(entry)).ltrim(FEEDBACK_KEY, 0, MAX_ENTRIES - 1).exec();
    } catch (err) {
      console.error("[ask-feedback] redis write failed:", err);
    }
  }
  return NextResponse.json({ ok: true, stored: kvEnabled });
}

export async function GET(req: NextRequest) {
  const limitParam = Number(req.nextUrl.searchParams.get("limit") ?? "50");
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? Math.floor(limitParam) : 50, 1), MAX_ENTRIES);
  const rating = req.nextUrl.searchParams.get("rating");
  if (rating !== null && !isRating(rating)) {
    return NextResponse.json({ error: "rating 必須是 up、down 或 report" }, { status: 400 });
  }
  if (!redis) {
    return NextResponse.json({ enabled: false, count: 0, items: [] });
  }
  try {
    // 有篩選時要多撈（最多整份 300 筆）再過濾，否則 limit 筆裡可能一筆都不符合。
    const rows = await redis.lrange(FEEDBACK_KEY, 0, (rating ? MAX_ENTRIES : limit) - 1);
    const parsed = rows.map((r): FeedbackEntry | null => {
      if (typeof r !== "string") return r as FeedbackEntry;
      try {
        return JSON.parse(r) as FeedbackEntry;
      } catch {
        return null;
      }
    });
    const items = parsed.filter((x): x is FeedbackEntry => x !== null && (!rating || x.rating === rating)).slice(0, limit);
    return NextResponse.json({ enabled: true, count: items.length, items });
  } catch (err) {
    console.error("[ask-feedback] redis read failed:", err);
    return NextResponse.json({ error: "讀取失敗" }, { status: 500 });
  }
}
