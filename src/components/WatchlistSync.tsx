"use client";

import { useEffect } from "react";
import { WATCHLIST_CHANGED_EVENT, getWatchlist, replaceWatchlist, type WatchlistItem } from "@/lib/watchlist";
import { useProfile } from "@/lib/auth/useProfile";
import { WATCHLIST_DIRTY_KEY, WATCHLIST_OWNER_KEY } from "@/lib/watchlistOwner";

/**
 * 關注清單與庫存綁定帳號（存在試算表 Holdings 分頁，見 lib/watchlistStore.ts）。
 * 畫面一樣讀寫 localStorage，這裡負責跟帳號同步：
 *
 * 1. 登入後先跟伺服器對齊（對齊前不推送，避免不完整的本機清單蓋掉帳號資料）：
 *    - 本機清單屬於「別的帳號」→ 直接換成這個帳號的清單（同一台電腦換人登入不會混在一起）。
 *    - 屬於自己、且有還沒送出的修改 → 以本機為準推上去。
 *    - 屬於自己、沒有待送修改 → 以帳號資料為準（在別的裝置刪掉的不會被這台加回來）。
 *    - 還沒有擁有者（第一次登入、或改版前的舊資料）→ 本機與帳號取聯集。
 * 2. 之後每次修改：先標記「有待送修改」，延遲 2 秒合併成一次 PUT，一次只送一個，成功才清標記。
 */
const PUSH_DELAY_MS = 2000;

function readLs(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeLs(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 無痕模式等存不了：同步仍會進行，只是少了換人登入的保護
  }
}

function union(local: WatchlistItem[], server: WatchlistItem[]): WatchlistItem[] {
  const map = new Map<string, WatchlistItem>();
  for (const item of [...server, ...local]) map.set(`${item.market}:${item.symbol}`, item);
  return [...map.values()];
}

export default function WatchlistSync() {
  const account = useProfile()?.account ?? "";

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    let ready = false;
    // replaceWatchlist 也會發出變更事件，套用帳號資料時要忽略，不能當成使用者修改
    let applying = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;
    let again = false;

    async function push() {
      if (inflight) {
        again = true;
        return;
      }
      inflight = true;
      try {
        const res = await fetch("/api/watchlist", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: getWatchlist() }),
        });
        if (res.ok && !again) writeLs(WATCHLIST_DIRTY_KEY, null);
      } catch {
        // 網路失敗：保留「待送」標記，下次修改或下次開網站時再送
      } finally {
        inflight = false;
        if (again && !cancelled) {
          again = false;
          void push();
        }
      }
    }

    function onChange() {
      if (applying) return;
      writeLs(WATCHLIST_DIRTY_KEY, "1");
      if (!ready) return; // 還在跟帳號對齊，對齊完會一起處理
      clearTimeout(timer);
      timer = setTimeout(() => void push(), PUSH_DELAY_MS);
    }

    (async () => {
      try {
        const res = await fetch("/api/watchlist", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const server: WatchlistItem[] = (await res.json()).items ?? [];
        const owner = readLs(WATCHLIST_OWNER_KEY);
        const dirty = readLs(WATCHLIST_DIRTY_KEY) === "1";
        const local = getWatchlist();
        let next: WatchlistItem[];
        let needPush = false;
        if (owner && owner !== account) {
          next = server;
        } else if (owner === account) {
          next = dirty ? local : server;
          needPush = dirty;
        } else {
          next = union(local, server);
          needPush = next.length !== server.length || local.length > 0;
        }
        writeLs(WATCHLIST_OWNER_KEY, account);
        applying = true;
        try {
          replaceWatchlist(next);
        } finally {
          applying = false;
        }
        writeLs(WATCHLIST_DIRTY_KEY, needPush ? "1" : null);
        ready = true;
        if (needPush) void push();
      } catch {
        // 讀不到帳號資料（網路或試算表暫時故障）：先用本機清單，修改仍會標記待送，下次開網站再對齊
      }
    })();

    window.addEventListener(WATCHLIST_CHANGED_EVENT, onChange);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener(WATCHLIST_CHANGED_EVENT, onChange);
    };
  }, [account]);

  return null;
}
