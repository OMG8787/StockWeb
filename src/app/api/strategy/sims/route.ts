import type { NextRequest } from "next/server";
import { body, handle } from "@/lib/strategy/http";
import { deleteSim, listSims, saveSim } from "@/lib/strategy/store";

export const GET = (req: NextRequest) => handle(req, async (o) => ({ items: await listSims(o.userId) }));
export const POST = (req: NextRequest) => handle(req, async (o) => ({ item: await saveSim(o, await body(req)) }));
export const DELETE = (req: NextRequest) =>
  handle(req, async (o) => {
    await deleteSim(o, req.nextUrl.searchParams.get("id") ?? "");
    return { ok: true };
  });
