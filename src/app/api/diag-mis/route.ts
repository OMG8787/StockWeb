// 暫時性診斷（2026-10-06）：比較 MIS 不同 ex_ch 寫法回的資料新舊。查完即刪。
import { NextResponse } from "next/server";

type Row = { c?: string; t?: string; tlong?: string; v?: string };

async function probe(label: string, exCh: string, extra = "") {
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0&_=${Date.now()}${extra}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { Referer: "https://mis.twse.com.tw/stock/index.jsp" }, cache: "no-store", signal: AbortSignal.timeout(8000) });
    const j = (await res.json()) as { msgArray?: Row[]; queryTime?: { sysTime?: string } };
    const r = j.msgArray?.find((x) => x.c === "2317");
    const now = Date.now();
    return { label, ms: now - t0, t: r?.t, v: r?.v, ageSec: r?.tlong ? Math.round((now - Number(r.tlong)) / 1000) : null, sys: j.queryTime?.sysTime };
  } catch (e) {
    return { label, error: String(e) };
  }
}

export async function GET() {
  const results = await Promise.all([
    probe("V1 單檔", "tse_2317.tw"),
    probe("V2 2317|2330", "tse_2317.tw|tse_2330.tw"),
    probe("V3 2330|2317", "tse_2330.tw|tse_2317.tw"),
    probe("V4 2317|8069", "tse_2317.tw|otc_8069.tw"),
    probe("V5 單檔+額外參數", "tse_2317.tw", `&x=${Math.random()}`),
    probe("V6 2317|2603|2454", "tse_2317.tw|tse_2603.tw|tse_2454.tw"),
  ]);
  return NextResponse.json({ now: new Date().toISOString(), results });
}
