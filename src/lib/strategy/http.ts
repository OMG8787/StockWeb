import { NextResponse, type NextRequest } from "next/server";
import { authErrorResponse, sessionFrom } from "@/lib/auth/server";
import { StrategyError, type Owner } from "./store";

/** 策略相關 API 共用：取登入者（proxy 已擋權限）、統一錯誤回應。 */
export function ownerOf(req: NextRequest): Owner | null {
  const s = sessionFrom(req);
  return s ? { userId: s.uid, account: s.acc } : null;
}

export async function handle(req: NextRequest, fn: (owner: Owner) => Promise<unknown>): Promise<NextResponse> {
  const owner = ownerOf(req);
  if (!owner) return NextResponse.json({ error: "未登入" }, { status: 401 });
  try {
    return NextResponse.json(await fn(owner));
  } catch (err) {
    if (err instanceof StrategyError) return NextResponse.json({ error: err.message }, { status: err.status });
    return authErrorResponse(err);
  }
}

export async function body<T = Record<string, unknown>>(req: NextRequest): Promise<T> {
  return ((await req.json().catch(() => null)) ?? {}) as T;
}
