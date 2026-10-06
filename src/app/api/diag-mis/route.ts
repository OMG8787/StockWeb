// 暫時性診斷（2026-10-06）：比較 MIS 不同請求方式回的資料新舊。查完即刪。
import { NextResponse } from "next/server";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
type Row = { t?: string; tlong?: string; d?: string; v?: string; z?: string; ts?: string };

async function probe(label: string, url: string, headers: Record<string, string>) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(8000) });
    const j = (await res.json()) as { msgArray?: Row[]; queryTime?: { sysTime?: string; sysDate?: string } };
    const r = j.msgArray?.[0];
    const now = Date.now();
    return {
      label, ms: now - t0, status: res.status, t: r?.t, tlong: r?.tlong, v: r?.v, z: r?.z,
      ageSec: r?.tlong ? Math.round((now - Number(r.tlong)) / 1000) : null,
      sys: j.queryTime?.sysTime,
    };
  } catch (e) {
    return { label, error: String(e) };
  }
}

export async function GET() {
  const base = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2317.tw&json=1&delay=0";
  const ref = { Referer: "https://mis.twse.com.tw/stock/index.jsp" };
  const results = [];
  results.push(await probe("A 現行(有_)", `${base}&_=${Date.now()}`, ref));
  results.push(await probe("A2 現行無_", base, ref));
  results.push(await probe("B 瀏覽器UA", `${base}&_=${Date.now()}`, { ...ref, "User-Agent": UA, Accept: "application/json, text/javascript, */*; q=0.01" }));
  // C：先拿 session cookie
  let cookie = "";
  try {
    const idx = await fetch("https://mis.twse.com.tw/stock/index.jsp", { headers: { "User-Agent": UA }, cache: "no-store", signal: AbortSignal.timeout(8000) });
    cookie = (idx.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  } catch {}
  results.push(await probe(`C session cookie(${cookie ? "有" : "無"})`, `${base}&_=${Date.now()}`, { ...ref, "User-Agent": UA, Cookie: cookie }));
  results.push(await probe("D 現行再打一次", `${base}&_=${Date.now()}`, ref));
  return NextResponse.json({ now: new Date().toISOString(), results });
}
