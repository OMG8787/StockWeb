import type { NextRequest } from "next/server";
import { body, handle } from "@/lib/strategy/http";
import { normalizePickLimit } from "@/lib/aiPickLimits";
import { getAlertConfig, saveAlertConfig } from "@/lib/strategy/store";

/** 帳號自己設定的 AI 建議名單檔數（依本站評分排名取前 N 檔）：GET 讀、POST { limit } 存。與即時提醒設定同一列。 */
export const GET = (req: NextRequest) => handle(req, async (o) => ({ limit: (await getAlertConfig(o.userId)).aiPickLimit }));
export const POST = (req: NextRequest) =>
  handle(req, async (o) => {
    const cfg = await getAlertConfig(o.userId);
    const limit = normalizePickLimit((await body<{ limit?: unknown }>(req)).limit);
    await saveAlertConfig(o, { ...cfg, aiPickLimit: limit });
    return { limit };
  });
