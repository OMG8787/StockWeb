import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

export const maxDuration = 120;

/**
 * 診斷用：在 Vercel 伺服器端量「POST 到 Apps Script」與「取回結果」各花多久，
 * 用來分辨慢是 Vercel→Google 的網路、Google 轉址，還是 Apps Script 本身（2026-10-08 正式站儲存要 10～50 秒，本機直打只要 2 秒）。
 * 不經過 GasStore 的任何暫存與重試；只做一次讀取與一次不影響資料的寫入（更新不存在的列）。
 * 要帶標頭 x-ping＝AUTH_GAS_SECRET 的 SHA-256 前 12 碼才能用（路徑在 /api/cron/ 底下是公開的，所以自己擋）。
 */
async function timed(url: string, secret: string, ops: unknown[]) {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ secret, ops }),
    redirect: "manual",
    cache: "no-store",
  });
  const postMs = Date.now() - t0;
  const loc = res.headers.get("location");
  if (!loc) return { postMs, status: res.status, resultMs: null as number | null };
  const t1 = Date.now();
  const r2 = await fetch(loc, { cache: "no-store" });
  const text = await r2.text();
  return { postMs, status: res.status, resultStatus: r2.status, resultMs: Date.now() - t1, bytes: text.length, ok: text.includes('"success":true') };
}

export async function GET(req: NextRequest) {
  const url = process.env.AUTH_GAS_URL;
  const secret = process.env.AUTH_GAS_SECRET;
  if (!url || !secret) return NextResponse.json({ error: "未設定" }, { status: 404 });
  if (req.headers.get("x-ping") !== createHash("sha256").update(secret).digest("hex").slice(0, 12)) {
    return NextResponse.json({ error: "未授權" }, { status: 401 });
  }
  const out: Record<string, unknown> = { region: process.env.VERCEL_REGION ?? null, at: new Date().toISOString() };
  const runs: Array<[string, unknown[]]> = [
    ["讀 Indicators", [{ op: "read", table: "Indicators" }]],
    ["讀 Indicators（再一次）", [{ op: "read", table: "Indicators" }]],
    ["讀 Users", [{ op: "read", table: "Users" }]],
    ["寫（更新不存在的列）", [{ op: "update", table: "Alerts", key: "zz-ping", patch: { UpdatedAt: "x" } }]],
    ["寫（再一次）", [{ op: "update", table: "Alerts", key: "zz-ping", patch: { UpdatedAt: "x" } }]],
  ];
  for (const [name, ops] of runs) {
    try {
      out[name] = await timed(url, secret, ops);
    } catch (err) {
      out[name] = { error: (err as Error).message };
    }
  }
  return NextResponse.json(out);
}
