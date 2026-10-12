"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OperationAdvice } from "@/lib/ai/operationAdvice";
import { clientRefreshMs } from "@/lib/autoRefresh";
import { quoteBatchKey } from "@/lib/quotesBatchApi";
import { hasHolding, type WatchlistItem } from "@/lib/watchlist";
import { useLivePolling } from "@/lib/useLivePolling";

/**
 * 關注清單「操作建議」欄的資料（買／賣／續抱／不買，加 * ＝需觀察）：一次向 /api/watchlist/advice 要整份清單，
 * 結論來自本站綜合評等（伺服器有 10 分鐘評等快取），前端 5 分鐘（盤中）／20 分鐘更新一次；
 * 第一次冷算還沒算完的，20 秒後再來拿。有填持有股數與成本的股票用「持有中」的建議，其餘用「還沒持有」。
 */

interface AdviceState {
  items: Record<string, OperationAdvice>;
  /** 還沒拿到第一次結果 */
  loading: boolean;
}
const Ctx = createContext<AdviceState>({ items: {}, loading: false });

export function WatchAdviceProvider({ list, children }: { list: WatchlistItem[]; children: ReactNode }) {
  const [items, setItems] = useState<Record<string, OperationAdvice>>({});
  const [loaded, setLoaded] = useState(false);
  const pendingRef = useRef(false);
  // 清單內容＋是否持有一變就重新要（restartKey）
  const query = list.map((w) => `${w.market}:${w.symbol.toUpperCase()}:${hasHolding(w) ? 1 : 0}`).join(",");
  const queryRef = useRef(query);
  // 在 effect 裡更新（宣告在輪詢前面，所以先於輪詢的第一次抓取執行）
  useEffect(() => {
    queryRef.current = query;
  });

  useLivePolling({
    restartKey: query,
    fetchOnMount: list.length > 0,
    decide: (now) => ({ fetch: list.length > 0, settle: false, nextCheckMs: pendingRef.current ? 20_000 : clientRefreshMs(now) }),
    onFetch: async () => {
      const q = queryRef.current;
      if (!q) return;
      try {
        const res = await fetch(`/api/watchlist/advice?items=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const body = (await res.json()) as { items: Record<string, OperationAdvice>; pending: string[] };
        pendingRef.current = body.pending.length > 0;
        if (queryRef.current !== q) return; // 清單在等待期間又變了，這份過期了
        setItems((prev) => ({ ...prev, ...body.items }));
        setLoaded(true);
      } catch {
        // 抓不到就保持畫面上已有的，下一輪再試
      }
    },
  });

  const value = useMemo(() => ({ items, loading: !loaded && list.length > 0 }), [items, loaded, list.length]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const COLORS: Record<string, string> = {
  買: "bg-(--price-up)/12 text-(--price-up)",
  賣: "bg-(--price-down)/12 text-(--price-down)",
  續抱: "bg-(--accent)/12 text-(--accent)",
  不買: "bg-(--page-plane) text-(--text-muted)",
};

/** 表格裡的「操作建議」儲存格內容：標籤＋滑鼠移上去的說明 */
export function AdviceBadge({ market, symbol }: { market: string; symbol: string }) {
  const { items, loading } = useContext(Ctx);
  const a = items[quoteBatchKey(market === "US" ? "US" : "TW", symbol)];
  if (!a) return <span className="text-(--text-muted)" title={loading ? "計算本站評等中…" : "這檔目前沒有評等（資料不足）"}>{loading ? "…" : "—"}</span>;
  return (
    <span
      title={a.tip}
      className={`inline-block cursor-help rounded px-1.5 py-0.5 text-xs font-semibold ${COLORS[a.action] ?? ""} ${a.watch ? "ring-1 ring-current" : ""}`}
    >
      {a.text}
    </span>
  );
}
