"use client";

import { useSyncExternalStore } from "react";
import type { Market } from "@/lib/data";
import { WATCHLIST_CHANGED_EVENT, isWatched, toggleWatch } from "@/lib/watchlist";

function subscribe(callback: () => void) {
  window.addEventListener(WATCHLIST_CHANGED_EVENT, callback);
  return () => window.removeEventListener(WATCHLIST_CHANGED_EVENT, callback);
}

export default function WatchlistButton({
  symbol,
  market,
  name,
  size = "sm",
}: {
  symbol: string;
  market: Market;
  name: string;
  size?: "sm" | "md";
}) {
  const watched = useSyncExternalStore(
    subscribe,
    () => isWatched(symbol, market),
    () => false // server snapshot: localStorage isn't available during SSR
  );

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleWatch({ symbol, market, name });
      }}
      aria-pressed={watched}
      aria-label={watched ? `從關注清單移除 ${name}` : `加入關注清單 ${name}`}
      title={watched ? "取消關注" : "加入關注"}
      // after:-inset-1.5：看不見的外框把點擊範圍放大到約 36px（全站檢查：手機上 ☆ 只有 24px 不好點），版面不變
      className={`relative inline-flex items-center justify-center rounded-full transition-colors after:absolute after:-inset-1.5 after:content-[''] ${
        size === "sm" ? "h-6 w-6 text-base" : "h-9 w-9 text-xl"
      } ${watched ? "text-(--accent)" : "text-(--text-muted) hover:text-(--accent)"}`}
    >
      {watched ? "★" : "☆"}
    </button>
  );
}
