import { getWatchlist, replaceWatchlist } from "@/lib/watchlist";

/** 本機關注清單屬於哪個帳號（WatchlistSync 用來判斷同一台電腦是否換人登入） */
export const WATCHLIST_OWNER_KEY = "stockradar:watchlist-owner";
/** 本機有還沒送到帳號的修改 */
export const WATCHLIST_DIRTY_KEY = "stockradar:watchlist-dirty";

/**
 * 登出時呼叫：有還沒送出的修改先送上帳號，再清掉這台電腦上的清單，
 * 下一個在這台電腦登入的人看不到前一個人的關注清單與庫存。
 */
export async function flushAndClearLocalWatchlist(): Promise<void> {
  try {
    if (localStorage.getItem(WATCHLIST_DIRTY_KEY) === "1") {
      await fetch("/api/watchlist", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: getWatchlist() }),
      }).catch(() => {});
    }
    localStorage.removeItem(WATCHLIST_OWNER_KEY);
    localStorage.removeItem(WATCHLIST_DIRTY_KEY);
  } catch {
    // localStorage 不可用就跳過
  }
  replaceWatchlist([]);
}
