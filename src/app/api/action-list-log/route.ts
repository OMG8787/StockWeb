import { NextResponse } from "next/server";
import { readActionListLog } from "@/lib/ai/actionListLog";
import { privateCache } from "@/lib/apiCache";

/** AI 建議清單的進出紀錄（最新在前）；「今日建議」頁的紀錄區用。proxy 已用「今日建議」權限擋掉其他人。 */
export async function GET() {
  try {
    const entries = await readActionListLog();
    return NextResponse.json({ entries }, { headers: privateCache(60, 300) });
  } catch (err) {
    console.error("[api] action-list-log failed:", err);
    return NextResponse.json({ error: "建議紀錄暫時無法取得" }, { status: 503 });
  }
}
