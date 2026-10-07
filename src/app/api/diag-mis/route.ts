import { NextRequest, NextResponse } from "next/server";

// 暫時診斷用（2026-10-07 MIS 資料年齡實驗），實驗完當天刪除。不寫 Redis、受 proxy cookie 保護。
export const maxDuration = 30;
const INSTANCE = Math.random().toString(36).slice(2, 8);
let sessionCookie: { at: number; value: string } | null = null;

type Variant = {
  name: string;
  ex?: string;
  delay?: string; // "0" | "1" | "none"
  ts?: number; // 1 = 帶 _=毫秒
  ua?: string; // "none" | "chrome"
  ref?: number;
  sess?: number;
  ep?: string; // "info" | "getStock" | "raw"
  extra?: string;
  proto?: string;
  json?: number;
  rand?: number; // 1 = 在 ex_ch 末端加隨機不存在代號
  cc?: number; // 1 = 送 Cache-Control: no-cache
};

async function getSession(): Promise<string> {
  if (sessionCookie && Date.now() - sessionCookie.at < 60_000) return sessionCookie.value;
  const r = await fetch("https://mis.twse.com.tw/stock/index.jsp", {
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36" },
  });
  const sc = r.headers.getSetCookie?.() ?? [];
  const value = sc.map((c) => c.split(";")[0]).join("; ");
  sessionCookie = { at: Date.now(), value };
  return value;
}

async function run(v: Variant) {
  let ex = v.ex ?? "tse_2317.tw";
  if (v.rand) ex += `|tse_9${Math.floor(Math.random() * 9000 + 1000)}.tw`;
  const proto = v.proto ?? "https";
  const q: string[] = [];
  if (v.ep === "getStock") {
    q.push(`ch=${ex.replace(/tse_|otc_/g, "").replace(/\|/g, "|")}`);
  } else q.push(`ex_ch=${ex}`);
  if (v.json !== 0) q.push("json=1");
  if (v.delay !== "none") q.push(`delay=${v.delay ?? "0"}`);
  const t0 = Date.now();
  if (v.ts !== 0) q.push(`_=${t0}`);
  if (v.extra) q.push(v.extra);
  const path = v.ep === "getStock" ? "getStock.jsp" : "getStockInfo.jsp";
  const url = `${proto}://mis.twse.com.tw/stock/api/${path}?${q.join("&")}`;
  const headers: Record<string, string> = {};
  if (v.ua === "chrome")
    headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
  if (v.ref) headers["Referer"] = "https://mis.twse.com.tw/stock/index.jsp";
  if (v.cc) {
    headers["Cache-Control"] = "no-cache";
    headers["Pragma"] = "no-cache";
  }
  try {
    if (v.sess) headers["Cookie"] = await getSession();
    const res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(8000) });
    const t1 = Date.now();
    const text = await res.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {}
    const rows: any[] = data?.msgArray ?? [];
    const qt = data?.queryTime ?? {};
    let snap: number | null = null;
    if (qt.sysDate && qt.sysTime) snap = Date.parse(`${qt.sysDate.slice(0, 4)}-${qt.sysDate.slice(4, 6)}-${qt.sysDate.slice(6, 8)}T${qt.sysTime}+08:00`);
    const hdr: Record<string, string> = {};
    for (const k of ["age", "cache-control", "x-cache", "via", "server", "date", "expires", "last-modified", "etag", "x-served-by"]) {
      const h = res.headers.get(k);
      if (h) hdr[k] = h;
    }
    return {
      name: v.name,
      status: res.status,
      t0,
      ms: t1 - t0,
      snapAge: snap ? (t0 - snap) / 1000 : null,
      sysTime: qt.sysTime,
      rows: rows
        .filter((r) => r.c && !String(r.c).startsWith("9"))
        .map((r) => ({ c: r.c, tlong: r.tlong, t: r.t, z: r.z, age: r.tlong ? (t0 - Number(r.tlong)) / 1000 : null })),
      hdr,
      bodyHead: data ? undefined : text.slice(0, 120),
    };
  } catch (e) {
    return { name: v.name, error: String(e), t0, ms: Date.now() - t0 };
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { plan?: Variant[]; parallel?: boolean; gapMs?: number } | null;
  const plan = body?.plan ?? [];
  if (plan.length === 0 || plan.length > 20) return NextResponse.json({ error: "plan 1~20" }, { status: 400 });
  const out = [];
  if (body?.parallel === false) {
    for (const v of plan) {
      out.push(await run(v));
      if (body.gapMs) await new Promise((r) => setTimeout(r, body.gapMs));
    }
  } else out.push(...(await Promise.all(plan.map(run))));
  return NextResponse.json({ instance: INSTANCE, now: Date.now(), out });
}
