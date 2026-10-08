/**
 * API 回應的「瀏覽器端快取」標頭（2026-10-08 使用者：每日或每小時才更新的資料放前端、不要每次都呼叫伺服器）。
 * private＝只有使用者自己的瀏覽器能快取，不進 CDN／共用快取；max-age 內同一個瀏覽器重複要同一網址不會打到伺服器
 *（也就不會讀 Redis）；stale-while-revalidate 內先用舊的、背景更新。
 * 只給「全站共通且更新很慢」的資料用（族群清單、指標目錄、代號查詢、新聞牆、評等紀錄、快報存檔）；
 * 個人資料（關注清單、策略、提醒設定、模擬倉）與盤中即時資料（報價、指數、台指期）絕對不要用。
 * 呼叫端若要略過快取（例如剛改完要立刻看到），fetch 加 cache: "no-store" 或 "reload"。
 */
export function privateCache(maxAgeSec: number, staleWhileRevalidateSec = 0): Record<string, string> {
  return {
    "Cache-Control": `private, max-age=${maxAgeSec}${staleWhileRevalidateSec ? `, stale-while-revalidate=${staleWhileRevalidateSec}` : ""}`,
  };
}
