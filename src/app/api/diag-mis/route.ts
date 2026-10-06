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
  const rnd = () => String(1000 + Math.floor(Math.random() * 8999));
  const results = await Promise.all([
    probe("W1 單檔", "tse_2317.tw"),
    probe("W2 重複代號", "tse_2317.tw|tse_2317.tw"),
    probe("W3 加t00", "tse_2317.tw|tse_t00.tw"),
    probe("W4 加隨機不存在代號", `tse_2317.tw|tse_${rnd()}.tw`),
    probe("W5 加隨機不存在代號B", `tse_${rnd()}.tw|tse_2317.tw`),
    probe("W6 delay=1", "tse_2317.tw", "&delay=1"),
  ]);
  return NextResponse.json({ now: new Date().toISOString(), results });
}
