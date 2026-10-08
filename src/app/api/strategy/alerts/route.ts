import type { NextRequest } from "next/server";
import { body, handle } from "@/lib/strategy/http";
import { getAlertConfig, saveAlertConfig, type AlertConfig } from "@/lib/strategy/store";

/** 即時提醒設定：GET 讀、POST 存 */
export const GET = (req: NextRequest) => handle(req, async (o) => ({ config: await getAlertConfig(o.userId) }));
export const POST = (req: NextRequest) => handle(req, async (o) => ({ config: await saveAlertConfig(o, await body<Partial<AlertConfig>>(req)) }));
