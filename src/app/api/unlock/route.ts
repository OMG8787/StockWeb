import { NextRequest, NextResponse } from "next/server";
import { UNLOCK_COOKIE } from "@/proxy";

// Hardcoded fallback so the gate works out of the box without any Vercel
// setup. This repo was made private on 2026-09-20 (see PROGRESS.md), so this
// literal is no longer publicly readable by anyone — but it's still visible
// to anyone with repo access, which is a materially weaker guarantee than an
// actual secret. Set SITE_PASSWORD in the Vercel project's environment
// variables (then redeploy) to override it with a real one; if the repo's
// visibility is ever flipped back to public, this fallback would need to
// change first.
const SITE_PASSWORD = process.env.SITE_PASSWORD || "1118";

export async function POST(req: NextRequest) {
  let body: { password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "格式錯誤" }, { status: 400 });
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (password !== SITE_PASSWORD) {
    return NextResponse.json({ error: "密碼錯誤" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(UNLOCK_COOKIE, "granted", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 一年 — 使用者要求「輸入一次後記住，之後不用再輸入」
  });
  return res;
}
