import type { NextRequest } from "next/server";
import { handle } from "@/lib/strategy/http";
import { checkAlerts } from "@/lib/strategy/compare";
import { getAlertConfig } from "@/lib/strategy/store";

export const maxDuration = 120;

/** 即時提醒：依目前設定檢查一次所有名單（前端每 10～30 秒呼叫） */
export const POST = (req: NextRequest) =>
  handle(req, async (o) => {
    const cfg = await getAlertConfig(o.userId);
    return checkAlerts(o.userId, cfg);
  });
