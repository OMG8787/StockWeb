/**
 * 「這是前景背景輪詢、使用者看不到等待」的請求標記（前後端共用，不含任何 server-only 依賴）。
 *
 * 2026-10-06 使用者：「盤中的股價與漲幅還是不夠即時，確定有 30 秒更新一次嗎？」根因：伺服器
 * 即時報價快取 TTL 25 秒 < 輪詢間隔 30 秒，每一輪打到的都是過期值；過期值只等背景重抓 1.5
 * 秒（首頁 5 秒預算留給單一資料源的上限），Vercel 在美國、MIS 在台灣，來不及就回「上一輪的
 * 舊值」——畫面永遠晚一輪。輪詢是背景請求、沒有人在盯著等，可以多等一點拿新值；首次載入
 * 才需要快（維持 1.5 秒）。所以前端輪詢請求帶這個 header，伺服器端對它放寬等待上限
 * （見 data/livePollContext.ts、data/swrPolicy.ts 的 liveRevalidateWaitMs）。
 */
export const LIVE_POLL_HEADER = "x-live-poll";

/**
 * 輪詢請求的 fetch 選項：掛載（首次載入）那一次不帶標記（使用者正在等畫面，維持 1.5 秒上限），
 * 之後每一輪輪詢／14:40 補抓／切回前景補抓都帶。所有 useLivePolling 的 onFetch 都該用這個，
 * 不要各自手寫 header 字串。
 */
export function livePollInit(ctx: { mount: boolean }): RequestInit | undefined {
  return ctx.mount ? undefined : { headers: { [LIVE_POLL_HEADER]: "1" } };
}
