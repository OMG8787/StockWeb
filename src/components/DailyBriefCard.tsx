"use client";

import { useState } from "react";
import type { DailyBrief } from "@/lib/ai/brief";
import { useFetchOnce } from "@/lib/useFetchOnce";
import MarkdownLite from "./MarkdownLite";

/**
 * Fetched client-side rather than server-rendered — the brief now covers
 * four sections (大盤連動/台股/美股/近期重點回顧) with news + chip grounding,
 * which made it the slowest thing on the homepage on a cache-cold day (see
 * MomentumSection.tsx for the same pattern, first used to fix this exact
 * class of problem on /highlights). This keeps a heavy/rare-cold-path AI
 * call from blocking the rest of the homepage (indices, movers, watchlist).
 */
// Collapsed height for the four-section brief — an Opus QA pass measured the
// full text taking up 42% of the homepage at mobile width (four screens of
// scrolling before reaching 大盤指數/焦點排行 below it) once the brief grew
// from a 3-paragraph summary to four sections. Collapsing by default keeps
// that scroll cost opt-in regardless of how long a given day's AI output
// ends up being, rather than depending on the model reliably hitting its
// requested word count (it doesn't — actual output has run ~2x the prompt's
// stated target).
const COLLAPSED_HEIGHT_PX = 220;

export default function DailyBriefCard() {
  const { data, failed } = useFetchOnce<{ brief: DailyBrief }>("/api/daily-brief");
  const brief = data?.brief ?? null;
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="rounded-lg border border-(--gridline) bg-(--surface-1) p-5">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">📰 今日市場快報</h2>
        {brief && !brief.usedAi && (
          <span className="rounded-full bg-(--page-plane) px-2 py-0.5 text-[13px] text-(--text-muted)">資料整理</span>
        )}
      </div>
      <div className="relative mt-2">
        <div
          className="space-y-1 overflow-hidden text-sm leading-relaxed text-(--text-secondary)"
          style={{ maxHeight: expanded ? undefined : `${COLLAPSED_HEIGHT_PX}px` }}
        >
          {failed ? (
            <p className="text-(--text-muted)">快報目前無法取得，請稍後再試。</p>
          ) : brief ? (
            <MarkdownLite text={brief.text} />
          ) : (
            <BriefSkeleton />
          )}
        </div>
        {brief && !expanded && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12"
            style={{ background: "linear-gradient(to bottom, transparent, var(--surface-1))" }}
          />
        )}
      </div>
      {brief && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 text-xs font-medium text-(--accent) hover:underline"
        >
          {expanded ? "收合" : "展開全文"}
        </button>
      )}
      <p className="mt-3 text-[13px] text-(--text-muted)">
        {brief?.usedAi ? "由 AI 依當前市場資料自動生成，" : ""}
        僅為資訊整理與客觀描述，不構成投資建議
        {brief ? ` · 更新於 ${new Date(brief.generatedAt).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei" })}` : ""}
      </p>
    </section>
  );
}

function BriefSkeleton() {
  return (
    <div className="space-y-2 py-1">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-3.5 animate-pulse rounded bg-(--page-plane)" style={{ width: `${85 - i * 8}%` }} />
      ))}
    </div>
  );
}
