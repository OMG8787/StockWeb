import { NextRequest, NextResponse } from "next/server";
import { withLivePollWait } from "@/lib/data/livePollContext";
import { getTaifexNightFutures } from "@/lib/data";

export async function GET(req: NextRequest) {
  try {
    const quote = await withLivePollWait(req, () => getTaifexNightFutures());
    return NextResponse.json({ quote });
  } catch (err) {
    console.error("[taifex-futures] getTaifexNightFutures failed:", err);
    return NextResponse.json({ error: "取得台指期夜盤報價時發生錯誤" }, { status: 500 });
  }
}
