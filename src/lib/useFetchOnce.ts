import { useEffect, useState } from "react";

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
 */
export function useFetchOnce<T>(url: string): FetchOnceState<T> {
  const [state, setState] = useState<FetchOnceState<T>>({ data: null, failed: false });

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`fetch failed: ${r.status}`))))
      .then((data: T) => {
        if (!cancelled) setState({ data, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}
