"use client";

import { useState } from "react";
import { getPollDecision, shouldRefreshSymbol } from "@/lib/pollingSchedule";
import { useLivePolling } from "@/lib/useLivePolling";
import { livePollInit } from "@/lib/livePoll";
import { quoteBatchKey, type QuotesBatchResponse } from "@/lib/quotesBatchApi";

/** 一批台股代號的即時現價與漲跌幅（盤中每 30 秒更新；同 ActionBriefCard 的節奏與批次 API，不另外打單檔報價） */
const POLL_MS = 30_000;

export interface TwQuote {
  price: number;
  changePercent: number;
  name: string;
}

export function useTwQuotes(symbols: string[]): Record<string, TwQuote> {
  const [quotes, setQuotes] = useState<Record<string, TwQuote>>({});
  const key = symbols.join(",");
  useLivePolling({
    restartKey: key,
    fetchOnMount: symbols.length > 0,
    decide: (now, settledDayKey) => {
      if (symbols.length === 0) return { fetch: false, settle: false, nextCheckMs: 60_000 };
      const d = getPollDecision("TW", now, settledDayKey);
      return d.fetch ? { ...d, nextCheckMs: Math.max(d.nextCheckMs, POLL_MS) } : d;
    },
    onFetch: async (ctx) => {
      if (symbols.length === 0 || !shouldRefreshSymbol("TW", ctx.now, ctx)) return;
      const items = symbols.map((s) => quoteBatchKey("TW", s)).join(",");
      const res = await fetch(`/api/quotes?items=${encodeURIComponent(items)}`, livePollInit(ctx));
      if (!res.ok) return;
      const body = (await res.json()) as QuotesBatchResponse;
      const fresh: Record<string, TwQuote> = {};
      for (const s of symbols) {
        const q = body.items[quoteBatchKey("TW", s)];
        if (q) fresh[s.toUpperCase()] = { price: q.price, changePercent: q.changePercent, name: q.name };
      }
      setQuotes((prev) => ({ ...prev, ...fresh }));
    },
  });
  return quotes;
}
