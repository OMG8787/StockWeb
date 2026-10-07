import type { NextRequest } from "next/server";
import { handle } from "@/lib/strategy/http";
import { getSim } from "@/lib/strategy/store";
import { runSim } from "@/lib/strategy/runner";

// 全市場模式要抓上百檔日K，給足時間（Vercel Hobby 上限內）
export const maxDuration = 300;

/** 立即依策略執行一次（以最新有收盤資料的交易日為準，同一交易日只執行一次） */
export const POST = (req: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  handle(req, async (o) => {
    const { id } = await params;
    return runSim(await getSim(o.userId, id));
  });
