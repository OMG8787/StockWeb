import { AsyncLocalStorage } from "node:async_hooks";
import { LIVE_POLL_HEADER } from "@/lib/livePoll";

/**
 * 請求範圍的「這是背景輪詢」旗標（AsyncLocalStorage）。資料層深處（cache.ts 的 SWR 過期等待）
 * 不能到處多傳一個參數，也不能靠每個呼叫端自己記得——所以由 API route 在最外層用
 * `withLivePollWait()` 包住整個處理流程，swrPolicy.ts 的 `liveRevalidateWaitMs()` 讀這個旗標
 * 決定「過期值要同步等背景重抓多久」。沒包（SSR 頁面、排程、AI 流程、腳本）一律是預設的
 * 短等待，不會被誤放寬。
 */
const storage = new AsyncLocalStorage<{ livePoll: true }>();

/** 目前這個請求範圍是不是前景背景輪詢。 */
export function isLivePollRequest(): boolean {
  return storage.getStore()?.livePoll === true;
}

/** 請求是否帶輪詢標記（前端 livePollInit() 加的 header）。 */
export function hasLivePollHeader(req: { headers: { get(name: string): string | null } }): boolean {
  return req.headers.get(LIVE_POLL_HEADER) === "1";
}

/**
 * 輪詢請求：在「過期值要同步等重抓、等多久」放寬的範圍內執行 `fn`；非輪詢請求原樣執行。
 * 即時資料的 API route（quote、quotes、search、indices、taifex-futures）最外層都用它包。
 */
export function withLivePollWait<T>(req: { headers: { get(name: string): string | null } }, fn: () => Promise<T>): Promise<T> {
  return hasLivePollHeader(req) ? storage.run({ livePoll: true }, fn) : fn();
}
