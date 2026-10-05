"use client";

import type { ActionBrief } from "@/lib/ai/actionBrief";
import { useFetchOnce } from "@/lib/useFetchOnce";
import { useBriefStance } from "./ActionBriefHeading";
import MarkdownLite from "./MarkdownLite";
import { writtenAtLabel } from "@/lib/ai/aiSchedule";

/**
 * Fetched client-side rather than server-rendered, same reasoning as
 * DailyBriefCard/MomentumSection: keeps this page's AI call (up to a 20s
 * timeout) from blocking the rest of the page render on a cache-cold visit.
 * Content targets <=400 characters (2026-10-04 concise format: one bullet
 * per pick), so no collapse/expand treatment is needed here.
 */
export default function ActionBriefCard() {
  const { data, failed } = useFetchOnce<{ actionBrief: ActionBrief }>("/api/action-brief");
  const brief = data?.actionBrief ?? null;
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
          <MarkdownLite text={brief.text} />
        ) : (
          <ActionBriefSkeleton />
        )}
      </div>
      <p className="mt-3 text-[13px] text-(--text-muted)">
        {brief?.usedAi ? "由 AI 依當前市場資料自動生成，" : ""}
        僅為個人參考看法，不構成投資建議
        {/* 2026-10-05 使用者：更新時間照實寫——分析文字只在固定時點重寫（aiSchedule.ts），數字另外即時更新。 */}
        {brief
          ? ` · ${
              brief.usedAi
                ? writtenAtLabel(brief.generatedAt, brief.model?.name, brief.fellBackToLite)
                : `資料整理於 ${new Date(brief.generatedAt).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false })}`
            }`
          : ""}
      </p>
    </section>
  );
}

function ActionBriefSkeleton() {
  return (
    <div className="space-y-2 py-1">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-3.5 animate-pulse rounded bg-(--page-plane)" style={{ width: `${85 - i * 8}%` }} />
      ))}
    </div>
  );
}
