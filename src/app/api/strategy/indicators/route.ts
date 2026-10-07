import type { NextRequest } from "next/server";
import { body, handle } from "@/lib/strategy/http";
import { deleteIndicator, listIndicators, saveIndicator } from "@/lib/strategy/store";

export const GET = (req: NextRequest) => handle(req, async (o) => ({ items: await listIndicators(o.userId) }));
export const POST = (req: NextRequest) => handle(req, async (o) => ({ item: await saveIndicator(o, await body(req)) }));
export const DELETE = (req: NextRequest) =>
  handle(req, async (o) => {
    await deleteIndicator(o, req.nextUrl.searchParams.get("id") ?? "");
    return { ok: true };
  });
