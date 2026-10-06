import { NextRequest, NextResponse } from "next/server";
import { withLivePollWait } from "@/lib/data/livePollContext";
import { getIndices } from "@/lib/data";

export async function GET(req: NextRequest) {
  try {
    const indices = await withLivePollWait(req, () => getIndices());
    return NextResponse.json({ indices });
  } catch (err) {
    console.error("[indices] getIndices failed:", err);
    return NextResponse.json({ error: "取得指數時發生錯誤" }, { status: 500 });
  }
}
