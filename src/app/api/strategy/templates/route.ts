import type { NextRequest } from "next/server";
import { body, handle } from "@/lib/strategy/http";
import { createFromTemplate } from "@/lib/strategy/templateCreate";

/** 策略範本一鍵建立：{ templateId } → 在自己的帳號建立需要的參考指標（已有相同的就沿用）與策略 */
export const POST = (req: NextRequest) =>
  handle(req, async (o) => createFromTemplate(o, String((await body<{ templateId?: unknown }>(req)).templateId ?? "")));
