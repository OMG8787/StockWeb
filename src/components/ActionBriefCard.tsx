"use client";

import type { ActionBrief } from "@/lib/ai/actionBrief";
import { useFetchOnce } from "@/lib/useFetchOnce";
import MarkdownLite from "./MarkdownLite";

/**
 * Fetched client-side rather than server-rendered, same reasoning as
 * DailyBriefCard/MomentumSection: keeps this page's AI call (up to a 20s
 * timeout) from blocking the rest of the page render on a cache-cold visit.
 * Unlike the daily brief this content targets ~350-550 characters (a direct
 * "what to buy today and why" read, not a four-section market wrap), so no
 * collapse/expand treatment is needed here.
 */
export default function ActionBriefCard() {
  const { data, failed } = useFetchOnce<{ actionBrief: ActionBrief }>("/api/action-brief");
  const brief = data?.actionBrief ?? null;

  return (
    <section className="rounded-lg border border-(--gridline) bg-(--surface-1) p-5">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">🎯 今日建議</h2>
        {brief && !brief.usedAi && (
          <span className="rounded-full bg-(--page-plane) px-2 py-0.5 text-[13px] text-(--text-muted)">資料整理</span>
        )}
      </div>
      <div className="mt-2 space-y-1 text-sm leading-relaxed text-(--text-secondary)">
        {failed ? (
          <p className="text-(--text-muted)">今日建議目前無法取得，請稍後再試。</p>
        ) : brief ? (
          <MarkdownLite text={brief.text} />
        ) : (
          <ActionBriefSkeleton />
        )}
      </div>
      <p className="mt-3 text-[13px] text-(--text-muted)">
        {brief?.usedAi ? "由 AI 依當前市場資料自動生成，" : ""}
        僅為個人參考看法，不構成投資建議
        {brief ? ` · 更新於 ${new Date(brief.generatedAt).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei" })}` : ""}
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
