import { useEffect, useRef, useState } from "react";
import { useLivePolling } from "@/lib/useLivePolling";

export interface FetchOnceState<T> {
  /** null 直到抓取完成——用它判斷要不要顯示loading骨架。 */
  data: T | null;
  /** true 代表這次抓取失敗（非2xx或網路錯誤），data 一定是 null。 */
  failed: boolean;
}

/**
 * 「元件掛載時抓一次資料、處理loading/失敗狀態、卸載後不再更新state」這個樣板，
 * 2026-09-22 地毯式審計發現原本在 ActionBriefCard／DailyBriefCard／MomentumSection
 * 各自手刻一份幾乎一模一樣的版本（`let cancelled = false` + fetch().then/catch +
 * cleanup），抽成這個共用hook，之後這幾個地方新增類似的卡片元件可以直接重用，不用
 * 重新手刻、也不會漏掉「卸載後不更新state」這個容易忘記的防護。
 *
 * 刻意只處理「掛載時抓一次、不會因為參數變動重新抓」這種最單純的情境——
 * `NewsFeedList.tsx`（有分頁載入更多）、`SearchClient.tsx`（篩選條件變動要重新
 * 抓、需要 AbortController 取消進行中的請求）、`StockChart.tsx`（symbol/range/market
 * 變動要重新抓）這三個檔案的抓取邏輯本質上更複雜，硬塞進同一個hook反而會讓hook
 * 本身變得難懂，維持各自獨立實作。
 *
 * 2026-10-06 加 `refreshMs`：使用者要求待在同一頁不動也要自動更新。傳入「現在 → 距離下次重抓幾毫秒（null＝
 * 不重抓）」，底層用 useLivePolling（分頁在背景時暫停、切回前景立刻補抓，跟全站報價輪詢同一套）。
 * 重抓失敗時保留畫面上已有的資料（不會把正常顯示的卡片換成「無法取得」）；沒傳＝行為跟以前逐字相同。
 * 節奏統一由 lib/autoRefresh.ts 的 clientRefreshMs 提供。
 */
export function useFetchOnce<T>(url: string, refreshMs?: (now: Date) => number | null): FetchOnceState<T> {
  const [state, setState] = useState<FetchOnceState<T>>({ data: null, failed: false });
  const latestUrl = useRef(url);
  // 在 effect 裡更新（宣告在 useLivePolling 前面，所以先於輪詢的第一次抓取執行）。
  useEffect(() => {
    latestUrl.current = url;
  });

  useLivePolling({
    restartKey: url,
    fetchOnMount: true,
    decide: (now) => {
      const ms = refreshMs?.(now) ?? null;
      // 沒有重抓節奏：只在掛載時抓一次，之後 1 小時才醒來看一眼（不抓）。
      return ms === null ? { fetch: false, settle: false, nextCheckMs: 60 * 60_000 } : { fetch: true, settle: false, nextCheckMs: ms };
    },
    onFetch: async () => {
      const target = url;
      try {
        const r = await fetch(target);
        if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
        const data = (await r.json()) as T;
        if (latestUrl.current === target) setState({ data, failed: false });
      } catch {
        // 重抓失敗不蓋掉畫面上已有的資料；第一次就失敗才標記 failed。
        if (latestUrl.current === target) setState((prev) => (prev.data ? prev : { data: null, failed: true }));
      }
    },
  });

  return state;
}
