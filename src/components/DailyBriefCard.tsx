"use client";

import { useEffect, useRef, useState } from "react";
import BriefSkeleton from "./BriefSkeleton";
import type { DailyBrief } from "@/lib/ai/brief";
import { useFetchOnce } from "@/lib/useFetchOnce";
import { clientRefreshMs } from "@/lib/autoRefresh";
import MarkdownLite from "./MarkdownLite";
import { writtenAtLabel } from "@/lib/ai/aiSchedule";

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
// 2026-10-04：快報改成精簡格式（總結＋台美條列＋留意，約300-450字）後，正常長度在
// 320px 內就能完整顯示；收合改成「真的超過才出現」，避免短內容也蓋一層漸層＋展開按鈕。
// 2026-10-05：快報加長到 600~900 字（今日重點＋現象→原因→後續），預設收合高度拉到 420，先看到今日重點與台股第一點。
const COLLAPSED_HEIGHT_PX = 420;

export default function DailyBriefCard() {
  const { data, failed } = useFetchOnce<{ brief: DailyBrief }>("/api/daily-brief", clientRefreshMs);
  const brief = data?.brief ?? null;
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setOverflowing(el.scrollHeight > COLLAPSED_HEIGHT_PX + 4));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
          ref={contentRef}
          className="space-y-1 overflow-hidden text-sm leading-relaxed text-(--text-secondary)"
          style={{ maxHeight: expanded ? undefined : `${COLLAPSED_HEIGHT_PX}px` }}
        >
          {failed ? (
            <p className="text-(--text-muted)">快報目前無法取得，請稍後再試。</p>
          ) : brief ? (
            <MarkdownLite text={brief.text} />
          ) : (
            <BriefSkeleton lines={5} />
          )}
        </div>
        {brief && overflowing && !expanded && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12"
            style={{ background: "linear-gradient(to bottom, transparent, var(--surface-1))" }}
          />
        )}
      </div>
      {brief && overflowing && (
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

