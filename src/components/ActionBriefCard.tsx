"use client";

import { useState } from "react";
import BriefSkeleton from "./BriefSkeleton";
import type { ActionBrief } from "@/lib/ai/actionBrief";
import { formatLiveQuote, patchLiveQuotes } from "@/lib/ai/livePrice";
import { getPollDecision, shouldRefreshSymbol } from "@/lib/pollingSchedule";
import { useLivePolling } from "@/lib/useLivePolling";
import { livePollInit } from "@/lib/livePoll";
import { quoteBatchKey, type QuotesBatchResponse } from "@/lib/quotesBatchApi";
import { useFetchOnce } from "@/lib/useFetchOnce";
import { clientRefreshMs } from "@/lib/autoRefresh";
import { useBriefStance } from "./ActionBriefHeading";
import MarkdownLite from "./MarkdownLite";
import { actionBriefTimeLabel } from "@/lib/ai/aiSchedule";

/**
 * Fetched client-side rather than server-rendered, same reasoning as
 * DailyBriefCard/MomentumSection: keeps this page's AI call (up to a 20s
 * timeout) from blocking the rest of the page render on a cache-cold visit.
 * Content targets <=400 characters (2026-10-04 concise format: one bullet
 * per pick), so no collapse/expand treatment is needed here.
 */
/** 現價輪詢最短間隔（2026-10-07 使用者：每檔都要顯示現價；盤中 30 秒更新，比關注清單的 10 秒省 API 次數） */
const LIVE_PRICE_POLL_MS = 30_000;

export default function ActionBriefCard() {
  const { data, failed } = useFetchOnce<{ actionBrief: ActionBrief }>("/api/action-brief", clientRefreshMs);
  const brief = data?.actionBrief ?? null;
  // 每檔現價（代號 → 新的「現價 X（±Y%，HH:MM）」片段）：盤中用既有批次報價 API 每 30 秒更新，名單文字本身不重抓。
  const [livePrices, setLivePrices] = useState<Record<string, string>>({});
  const symbols = brief ? [...brief.picks.map((p) => p.symbol), ...(brief.notChaseSymbol ? [brief.notChaseSymbol] : [])] : [];
  useLivePolling({
    restartKey: symbols.join(","),
    decide: (now, settledDayKey) => {
      const d = getPollDecision("TW", now, settledDayKey);
      return d.fetch ? { ...d, nextCheckMs: Math.max(d.nextCheckMs, LIVE_PRICE_POLL_MS) } : d;
    },
    onFetch: async (ctx) => {
      if (!brief || symbols.length === 0 || !shouldRefreshSymbol("TW", ctx.now, ctx)) return;
      const items = symbols.map((s) => quoteBatchKey("TW", s)).join(",");
      const res = await fetch(`/api/quotes?items=${encodeURIComponent(items)}`, livePollInit(ctx));
      if (!res.ok) return;
      const body = (await res.json()) as QuotesBatchResponse;
      const fresh: Record<string, string> = {};
      for (const s of symbols) {
        const q = body.items[quoteBatchKey("TW", s)];
        if (q) fresh[s] = formatLiveQuote(q, brief.picks.find((p) => p.symbol === s)?.ratingPrice);
      }
      setLivePrices((prev) => ({ ...prev, ...fresh }));
    },
  });
  const shownText = brief ? patchLiveQuotes(brief.text, livePrices) : "";
  // 標題跟著內容走（14:30 後是「明日操作建議」，見 tradingStance.ts）；還沒載入時依現在時段先顯示。
  const stance = useBriefStance();
  const title = brief?.title ?? stance.briefTitle;

  return (
    <section className="rounded-lg border border-(--gridline) bg-(--surface-1) p-5">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">🎯 {title}</h2>
        {brief && !brief.usedAi && (
          <span className="rounded-full bg-(--page-plane) px-2 py-0.5 text-[13px] text-(--text-muted)">資料整理</span>
        )}
      </div>
      <div className="mt-2 space-y-1 text-sm leading-relaxed text-(--text-secondary)">
        {failed ? (
          <p className="text-(--text-muted)">{title}目前無法取得，請稍後再試。</p>
        ) : brief ? (
          <MarkdownLite text={shownText} />
        ) : (
          <BriefSkeleton lines={4} />
        )}
      </div>
      <p className="mt-3 text-[13px] text-(--text-muted)">
        {brief?.usedAi ? "由 AI 依當前市場資料自動生成，" : ""}
        僅為個人參考看法，不構成投資建議
        {/* 2026-10-05 使用者：更新時間照實寫——分析文字只在固定時點重寫（aiSchedule.ts），數字另外即時更新。 */}
        {brief
          ? ` · ${
              actionBriefTimeLabel(brief.listAt ?? brief.generatedAt, brief.usedAi ? brief.generatedAt : null, brief.model?.name, brief.fellBackToLite)
            }`
          : ""}
      </p>
    </section>
  );
}

