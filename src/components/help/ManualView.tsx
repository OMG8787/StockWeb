"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import MarkdownLite from "../MarkdownLite";
import { MANUAL, MANUAL_GROUPS, type ManualSection } from "@/lib/help/manual";
import { filterManual } from "@/lib/help/search";
import { canSeePath } from "@/lib/auth/permissions";
import { useProfile } from "@/lib/auth/useProfile";

/**
 * 操作手冊瀏覽（教學助手的「📖 操作手冊」分頁與 /help 頁共用）：搜尋框＋依分類的章節列表，章節可展開，
 * 每章底下有「前往這個功能」連結。openId 指定時（例如助手回答下的「看手冊」按鈕）自動展開並捲到那一章。
 * compact＝聊天小視窗用的緊湊版（小字、連結在同分頁開啟後收起視窗由 onNavigate 通知）。
 */
export default function ManualView({
  openId,
  compact = false,
  onNavigate,
}: {
  openId?: string | null;
  compact?: boolean;
  /** 點章節裡的功能連結時通知外層（聊天視窗用來收起視窗） */
  onNavigate?: () => void;
}) {
  const profile = useProfile();
  // 帳號沒有權限的頁面：連結改成灰字說明（點了會被擋，全站驗證 10/16 發現）
  const canOpen = (href: string) => !profile || canSeePath(profile.perms, href.split("?")[0].split("#")[0]);
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!openId) return;
    const t = setTimeout(() => {
      setQuery("");
      setOpened((prev) => new Set(prev).add(openId));
      document.getElementById(`manual-${openId}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 50);
    return () => clearTimeout(t);
  }, [openId]);

  const shown = useMemo(() => filterManual(query), [query]);
  const searching = query.trim().length > 0;
  const toggle = (id: string) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const text = compact ? "text-xs" : "text-sm";
  const renderSection = (s: ManualSection) => {
    const isOpen = searching || opened.has(s.id);
    return (
      <div key={s.id} id={`manual-${s.id}`} className="rounded-md border border-(--gridline) bg-(--surface-1)">
        <button
          type="button"
          onClick={() => toggle(s.id)}
          aria-expanded={isOpen}
          className={`flex w-full items-start justify-between gap-2 px-3 py-2 text-left ${text} hover:bg-(--page-plane)`}
        >
          <span>
            <span className="block font-medium text-(--text-primary)">{s.title}</span>
            <span className="block text-(--text-muted)">{s.summary}</span>
          </span>
          <span className="shrink-0 text-(--text-muted)">{isOpen ? "▲" : "▼"}</span>
        </button>
        {isOpen && (
          <div className={`space-y-2 border-t border-(--gridline) px-3 py-2 leading-relaxed text-(--text-secondary) ${text}`}>
            <MarkdownLite text={s.body} />
            {s.links && s.links.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {s.links.map((l) =>
                  !canOpen(l.href) ? (
                    <span key={l.href} className="rounded-md border border-(--gridline) px-2 py-1 text-xs text-(--text-muted)" title="你的帳號沒有這項功能的權限，需要的話請聯絡管理員">
                      {l.label}（帳號未開通）
                    </span>
                  ) : (
                  <Link
                    key={l.href}
                    href={l.href}
                    prefetch={false}
                    onClick={onNavigate}
                    className="rounded-md border border-(--accent) bg-(--accent-soft) px-2 py-1 text-xs font-medium text-(--text-primary) hover:opacity-90"
                  >
                    前往：{l.label} →
                  </Link>
                  ),
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜尋手冊，例如：智能清單、回測、買＊、提醒"
        aria-label="搜尋操作手冊"
        className={`w-full rounded-md border border-(--gridline) bg-(--surface-2) px-3 py-2 ${text} focus:outline-none focus:ring-2 focus:ring-(--accent)`}
      />
      {searching ? (
        shown.length === 0 ? (
          <p className={`${text} text-(--text-muted)`}>手冊裡找不到「{query}」，換個關鍵字試試，或到右下角教學助手「問問題」。</p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-(--text-muted)">找到 {shown.length} 個章節：</p>
            {shown.map(renderSection)}
          </div>
        )
      ) : (
        MANUAL_GROUPS.map((g) => (
          <div key={g} className="space-y-2">
            <h3 className={`font-semibold text-(--text-primary) ${compact ? "text-xs" : "text-sm"}`}>{g}</h3>
            {MANUAL.filter((s) => s.group === g).map(renderSection)}
          </div>
        ))
      )}
    </div>
  );
}
