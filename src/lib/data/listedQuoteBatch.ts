import type { Quote } from "./types";
import { fetchTwseQuotesBatch } from "./twse";
import { reconcileTwListedQuoteMap } from "./twOffHoursQuote";

/**
 * 上市（TWSE）指定幾檔的即時報價，**只抓這幾檔**（MIS 一次最多 50 檔一個請求）。
 *
 * 2026-10-06 為什麼不再用全市場報價表（getMarketQuoteMap）：關注清單每 30 秒輪詢時，
 * 全市場表過期後要重抓 1000+ 檔（分塊 40 個請求），正式站實測重抓要 3~10 秒——輪詢請求
 * 同步等它會讓 /api/quotes 回應拖到 4~10 秒，不等又只能回舊表（畫面晚一輪）。關注清單
 * 通常只有幾檔到幾十檔，直接抓這幾檔只要 1~2 個 MIS 請求（約 0.5 秒），資料也更新，
 * 還省掉每 25 秒重建整張表的 Active CPU 與上游請求量。
 *
 * 解析與非交易時段校正跟全市場表同一套（twse.ts rowToQuote、twOffHoursQuote.ts），
 * 所以數字逐值相同。不走 Redis（key 含整份代號清單、每人不同，寫進 Upstash 會白白吃指令），
 * 只做 process 記憶體的短快取＋同一組代號單飛：同一 instance 同一組代號 10 秒內共用，
 * 比 30 秒輪詢短，所以每一輪輪詢仍拿到新值。抓不到的代號不在回傳的 Map 裡，由呼叫端退回單檔報價。
 */
const FRESH_MS = 10_000;
const MAX_ENTRIES = 50;

const recent = new Map<string, { at: number; promise: Promise<Map<string, Quote>> }>();

export function getListedQuotesLive(symbols: string[]): Promise<Map<string, Quote>> {
  const unique = Array.from(new Set(symbols)).sort();
  if (unique.length === 0) return Promise.resolve(new Map());
  const key = unique.join(",");
  const now = Date.now();
  const hit = recent.get(key);
  if (hit && now - hit.at <= FRESH_MS) return hit.promise;

  const promise = (async () => {
    const map = await fetchTwseQuotesBatch(unique, { retryStale: true }).catch(() => new Map<string, Quote>());
    if (map.size === 0) return map;
    return reconcileTwListedQuoteMap(map, () => "TWSE").catch(() => map);
  })();
  recent.set(key, { at: now, promise });
  // 空結果（上游失敗）不留著，下一個請求馬上重試；舊條目與超量條目順手清掉。
  void promise.then((m) => {
    if (m.size === 0 && recent.get(key)?.promise === promise) recent.delete(key);
  });
  if (recent.size > MAX_ENTRIES) {
    for (const [k, v] of recent) if (now - v.at > FRESH_MS || recent.size > MAX_ENTRIES) recent.delete(k);
  }
  return promise;
}
