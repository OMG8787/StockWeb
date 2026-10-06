"use client";

import { startTransition, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { serverRefreshMs } from "@/lib/autoRefresh";
import { IDLE_CHECK_MS } from "@/lib/pollingSchedule";
import { useLivePolling } from "@/lib/useLivePolling";

/**
 * 全站唯一的「伺服器渲染區塊自動更新」：掛在 layout，依路徑決定節奏（lib/autoRefresh.ts 的 serverRefreshMs），
 * 到點呼叫 router.refresh()。refresh 會重跑目前路由的 Server Components 並把結果併進畫面，
 * **不會**清掉用戶端 state（輸入框、AI 對話框、展開狀態）與捲動位置；包在 startTransition 裡，
 * Suspense 區塊重新載入時舊內容維持顯示、不閃骨架。只重跑伺服器端的渲染（資料層有快取），
 * 不會打到 AI。分頁在背景時暫停、切回前景立刻補一次（useLivePolling 的 pauseWhenHidden）。
 * 不渲染任何畫面。
 */
export default function PageAutoRefresh() {
  const router = useRouter();
  const pathname = usePathname();
  // 剛載入／剛換頁那一輪不 refresh：頁面剛由伺服器渲染完，立刻再刷一次是白工。記「已對哪個路徑評估過一輪」。
  const armedFor = useRef<string | null>(null);

  useLivePolling({
    restartKey: pathname,
    decide: (now) => {
      const ms = serverRefreshMs(pathname, now);
      if (ms === null) return { fetch: false, settle: false, nextCheckMs: IDLE_CHECK_MS };
      const fetch = armedFor.current === pathname;
      armedFor.current = pathname;
      return { fetch, settle: false, nextCheckMs: ms };
    },
    onFetch: () => {
      startTransition(() => router.refresh());
    },
  });

  return null;
}
