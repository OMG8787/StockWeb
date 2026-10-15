import { NextResponse } from "next/server";
import { readRecLedger } from "@/lib/ai/recLedger";
import { privateCache } from "@/lib/apiCache";

/** 推薦紀錄（歷史回顧頁用）：保存期限內的全部紀錄＋0050 收盤。proxy 已用「今日建議」權限擋掉其他人。 */
export async function GET() {
  try {
    return NextResponse.json(await readRecLedger(), { headers: privateCache(120, 600) });
  } catch (err) {
    console.error("[api] rec-ledger failed:", err);
    return NextResponse.json({ error: "推薦紀錄暫時無法取得" }, { status: 503 });
  }
}
