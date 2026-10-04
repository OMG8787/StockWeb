import type { Market, Quote } from "./data/types";

/**
 * 關注清單批次報價 `/api/quotes?items=TW:2330,US:AAPL` 前後端共用的契約（只放型別與純函式，
 * client/server 都能 import）。2026-10-04：首頁「我的關注」原本逐檔打 /api/quote，
 * 表格要 4~6 秒才完整出現，改成一次批次。
 */

/** 單次最多幾檔（比照 /api/chips-ratios 的上限）；前端超過就分批。 */
export const QUOTES_BATCH_MAX_SYMBOLS = 100;

/** 台股代號（同 chipsRatiosList.ts 的 TW_SYMBOL_PATTERN）／美股代號（含 BRK.B、^GSPC 之類）。 */
const TW_PATTERN = /^\d{4}[0-9A-Z]{0,2}$/;
const US_PATTERN = /^[A-Z0-9.\-^=]{1,15}$/;

export type QuoteWithSector = Quote & { sector?: string };

export interface QuotesBatchResponse {
  /** key＝`${market}:${symbol}`；null＝這一檔目前抓不到報價（前端顯示資料暫缺）。 */
  items: Record<string, QuoteWithSector | null>;
}

export function quoteBatchKey(market: Market, symbol: string): string {
  return `${market}:${symbol.toUpperCase()}`;
}

/** 解析 `items=TW:2330,US:AAPL`；格式不合的項目直接略過，回傳去重後的清單。 */
export function parseQuotesBatchItems(raw: string): Array<{ market: Market; symbol: string }> {
  const seen = new Set<string>();
  const out: Array<{ market: Market; symbol: string }> = [];
  for (const part of raw.split(",")) {
    const [m, s] = part.trim().split(":");
    const symbol = (s ?? "").trim().toUpperCase();
    if (m !== "TW" && m !== "US") continue;
    if (!(m === "TW" ? TW_PATTERN : US_PATTERN).test(symbol)) continue;
    const key = quoteBatchKey(m, symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ market: m, symbol });
  }
  return out;
}
