import { NextRequest, NextResponse } from "next/server";
import { getChipsRatiosBatch, MAJOR_WEB_FALLBACK_MAX_SYMBOLS } from "@/lib/data";
import {
  CHIPS_BATCH_MAX_SYMBOLS,
  TW_SYMBOL_PATTERN,
  toListRatios,
  type ChipsRatiosBatchResponse,
} from "@/lib/chipsRatiosList";

/**
 * 股票列表的籌碼比例欄位（大戶持股／外資持股／融資使用率／融券使用率＋前一期）批次版：
 * `/api/chips-ratios?symbols=2330,2317,...`，只收台股代號、單次最多
 * CHIPS_BATCH_MAX_SYMBOLS 檔，回傳精簡格式（lib/chipsRatiosList.ts）。
 *
 * 底層三份資料都是全市場整包快取（融資/外資 1 小時、大戶 6 小時），這支只在記憶體
 * 查表，不對每檔各打上游，也刻意**不**加進 warm-cache 排程。
 * `majorPrev=web`：檔數 ≤ MAJOR_WEB_FALLBACK_MAX_SYMBOLS 時，週快照還沒有上一週的
 * 那幾檔改用跟個股頁一樣的方式查集保官網補上一週（短清單專用，前端第二階段才發）。
 *
 * 回應用 `private` 瀏覽器快取 5 分鐘：網站有密碼保護，不讓共用 CDN 快取這份資料；
 * 伺服器端的新鮮度已由資料層 TTL 控制。
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("symbols") ?? "";
  const symbols = Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => TW_SYMBOL_PATTERN.test(s))
    )
  );
  if (symbols.length === 0) return NextResponse.json({ error: "請提供台股代號 symbols=2330,2317" }, { status: 400 });
  if (symbols.length > CHIPS_BATCH_MAX_SYMBOLS) {
    return NextResponse.json({ error: `單次最多 ${CHIPS_BATCH_MAX_SYMBOLS} 檔` }, { status: 400 });
  }
  const majorPrevFromWeb =
    req.nextUrl.searchParams.get("majorPrev") === "web" && symbols.length <= MAJOR_WEB_FALLBACK_MAX_SYMBOLS;

  try {
    const map = await getChipsRatiosBatch(symbols, { majorPrevFromWeb });
    const body: ChipsRatiosBatchResponse = { items: {} };
    for (const [symbol, ratios] of map) {
      body.items[symbol] = toListRatios(ratios);
      const major = ratios?.majorHolders;
      if (major && !body.majorDate) body.majorDate = major.date;
      if (major?.prevDate && !body.majorPrevDate) body.majorPrevDate = major.prevDate;
    }
    return NextResponse.json(body, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (err) {
    console.error("[chips-ratios batch] failed:", err);
    return NextResponse.json({ error: "取得籌碼比例時發生錯誤" }, { status: 500 });
  }
}
