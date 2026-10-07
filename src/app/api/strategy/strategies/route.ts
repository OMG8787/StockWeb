import type { NextRequest } from "next/server";
import { body, handle } from "@/lib/strategy/http";
import { deleteStrategy, listStrategies, saveStrategy } from "@/lib/strategy/store";

export const GET = (req: NextRequest) => handle(req, async (o) => ({ items: await listStrategies(o.userId) }));
export const POST = (req: NextRequest) => handle(req, async (o) => ({ item: await saveStrategy(o, await body(req)) }));
export const DELETE = (req: NextRequest) =>
  handle(req, async (o) => {
    await deleteStrategy(o, req.nextUrl.searchParams.get("id") ?? "");
    return { ok: true };
  });
