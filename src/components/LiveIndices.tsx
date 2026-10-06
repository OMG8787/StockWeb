"use client";

import { useState } from "react";
import type { IndexQuote, Market } from "@/lib/data";
import { getMarketStatus, type MarketStatus } from "@/lib/marketStatus";
import { getPollDecision } from "@/lib/pollingSchedule";
import { useLivePolling } from "@/lib/useLivePolling";
import { livePollInit } from "@/lib/livePoll";
import IndexCard from "./IndexCard";
import MarketStatusBadge from "./MarketStatusBadge";

/** Same live/closed-aware polling as LiveQuoteHeader（節奏一律由 lib/pollingSchedule.ts 決定），for the homepage's market-index cards. */
export default function LiveIndices({ market, initialIndices }: { market: Market; initialIndices: IndexQuote[] }) {
  const [indices, setIndices] = useState(initialIndices);
  const [status, setStatus] = useState<MarketStatus>(() => getMarketStatus(market));

  useLivePolling({
    restartKey: market,
    decide: (now, settledDayKey) => {
      setStatus(getMarketStatus(market, now));
      return getPollDecision(market, now, settledDayKey);
    },
    onFetch: async (ctx) => {
      const res = await fetch("/api/indices", livePollInit(ctx));
      if (!res.ok) return;
      const data = await res.json();
      const next: IndexQuote[] = (data.indices ?? []).filter((i: IndexQuote) => i.market === market);
      if (next.length > 0) setIndices(next);
    },
  });

  if (indices.length === 0) {
    return <p className="py-6 text-center text-sm text-(--text-muted)">大盤指數目前無法取得，請稍後再試</p>;
  }

  return (
    <div>
      <div className="mb-2 flex justify-end">
        <MarketStatusBadge status={status} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {indices.map((idx) => (
          <IndexCard key={idx.symbol} index={idx} />
        ))}
      </div>
    </div>
  );
}
