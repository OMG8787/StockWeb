"use client";

import { useEffect, useRef } from "react";
import { WATCHLIST_CHANGED_EVENT, getWatchlist, replaceWatchlist, type WatchlistItem } from "@/lib/watchlist";

function mergeByKey(a: WatchlistItem[], b: WatchlistItem[]): WatchlistItem[] {
  const map = new Map<string, WatchlistItem>();
  for (const item of [...a, ...b]) map.set(`${item.market}:${item.symbol}`, item);
  return Array.from(map.values());
}

function pushToServer() {
  fetch("/api/watchlist", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: getWatchlist() }),
  }).catch(() => {});
}

/**
 * Headless — mounted once near the app root (signed-in users with the
 * watchlist-sync permission only). On mount, merges this
 * device's local (localStorage) watchlist with whatever's already stored
 * for the account (union, never a destructive overwrite, so a fresh device
 * never wipes out an existing account watchlist or vice versa), then keeps
 * pushing local changes up to the server on every edit. If shared storage
 * isn't configured (see lib/watchlistStore.ts), this silently no-ops and
 * the watchlist just stays local to the device, exactly like before
 * sign-in existed.
 */
export default function WatchlistSync() {
  // 只在有「關注清單同步」權限時掛載（見 layout.tsx 的 RequirePerm），掛載＝已登入
  const mergedRef = useRef(false);

  useEffect(() => {
    if (mergedRef.current) return;
    mergedRef.current = true;
    (async () => {
      try {
        const res = await fetch("/api/watchlist");
        if (!res.ok) return;
        const data = await res.json();
        if (!data.syncAvailable) return;
        const merged = mergeByKey(getWatchlist(), data.items ?? []);
        replaceWatchlist(merged);
        pushToServer();
      } catch {
        // sync is best-effort; local watchlist keeps working regardless
      }
    })();
  }, []);

  useEffect(() => {
    window.addEventListener(WATCHLIST_CHANGED_EVENT, pushToServer);
    return () => window.removeEventListener(WATCHLIST_CHANGED_EVENT, pushToServer);
  }, []);

  return null;
}
