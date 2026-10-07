import type { NextRequest } from "next/server";
import { handle } from "@/lib/strategy/http";
import { getSim, listSimHistory } from "@/lib/strategy/store";

/** 模擬倉明細：狀態＋交易紀錄＋每日淨值 */
export const GET = (req: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  handle(req, async (o) => {
    const { id } = await params;
    const sim = await getSim(o.userId, id);
    return { sim, ...(await listSimHistory(o.userId, id)) };
  });
