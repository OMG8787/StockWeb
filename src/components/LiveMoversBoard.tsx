"use client";

import { useState } from "react";
import type { Market, SearchItem } from "@/lib/data";
import { getMarketStatus, type MarketStatus } from "@/lib/marketStatus";
import { getPollDecision } from "@/lib/pollingSchedule";
import { useLivePolling } from "@/lib/useLivePolling";
import StockTable from "./StockTable";
import MarketStatusBadge from "./MarketStatusBadge";

/**
 * Homepage's 焦點排行 movers table was plain server-rendered data with no
 * client refresh: a tab left open past the initial page load just kept
 * showing whatever price/漲跌幅 was true at that one render forever, which
 * read as "still showing yesterday's numbers" once the market had moved on.
 * Every other price-bearing view on the site (index cards, the stock detail
 * header) already re-polls while the market is open — this brings the
 * homepage movers list in line with that same pattern instead of being the
 * one static exception.
 *
 * 刷新節奏跟全站一致（lib/pollingSchedule.ts）：台股 08:30~14:30 每 10 秒、
 * 收盤後停輪詢並在 14:40 補一次。要留意這份排行底層是「全市場批次報價」
 * （lib/data/index.ts 的 MARKET_MAP_TTL_MS），那份快取盤中是 60 秒、盤後
 * 2 分鐘，所以畫面數字實際最快每分鐘才會換一次——那是刻意的成本取捨：
 * 全市場批次抓取是全站最貴的上游呼叫，縮到 10 秒會讓整個搜尋/排行頁重新
 * 變慢（見 PROGRESS.md 2026-09-11 那次效能事故）。
 */
export default function LiveMoversBoard({ market, initialItems }: { market: Market; initialItems: SearchItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [status, setStatus] = useState<MarketStatus>(() => getMarketStatus(market));

  useLivePolling({
    restartKey: market,
    decide: (now, settledDayKey) => {
      setStatus(getMarketStatus(market, now));
      return getPollDecision(market, now, settledDayKey);
    },
    onFetch: async () => {
      const res = await fetch(`/api/search?market=${market}&sortBy=changePercent&sortDir=desc&limit=8`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.items) && data.items.length > 0) setItems(data.items);
    },
  });

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <MarketStatusBadge status={status} />
        {status === "closed" && (
          <p className="text-xs text-(--text-muted)">非交易時段，以下為最近一次收盤資訊</p>
        )}
        {/* 08:30 起就會開始輪詢（試撮時段 TWSE/TPEx 已在公布模擬撮合價），所以
            這裡不再宣稱「以下為昨日收盤資訊」——那句話在有試撮價回來時會變成
            不實描述。改用跟 LiveQuoteHeader 一致的誠實措辭：不保證是哪一種價格，
            只明說尚未正式開盤、數字僅供參考。 */}
        {status === "pre-market" && (
          <p className="text-xs text-(--text-muted)">08:30-09:00試撮時段，尚未正式開盤，以下數字僅供參考</p>
        )}
      </div>
      <StockTable items={items} />
    </div>
  );
}
