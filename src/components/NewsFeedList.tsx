"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clientRefreshMs } from "@/lib/autoRefresh";
import { useLivePolling } from "@/lib/useLivePolling";
import Link from "next/link";
import type { NewsFeedItem } from "@/lib/ai/newsfeed";
import { formatTaipeiDateTime } from "@/lib/format";

const PAGE_LIMIT = 20;

interface FeedResponse {
  pinned: NewsFeedItem[];
  items: NewsFeedItem[];
  hasMore: boolean;
  generatedAt: string;
}

export default function NewsFeedList() {
  const [pinned, setPinned] = useState<NewsFeedItem[] | null>(null);
  const [items, setItems] = useState<NewsFeedItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialError, setInitialError] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Guards against the IntersectionObserver firing again while a fetch it
  // triggered is still in flight — `loadingMore` state alone can lag a
  // render behind a rapid second intersection event.
  const loadingRef = useRef(false);

  // Initial load — a plain fetch chain kicked off by the effect, same shape
  // as MomentumSection's: nothing in the effect body itself calls setState
  // synchronously (only the async .then() continuation does), which is what
  // React's set-state-in-effect rule wants to see.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/news-feed?offset=0&limit=${PAGE_LIMIT}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((data: FeedResponse) => {
        if (cancelled) return;
        setPinned(data.pinned ?? []);
        setItems(data.items);
        setHasMore(data.hasMore);
      })
      .catch(() => {
        if (!cancelled) setInitialError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 2026-10-06 待在新聞頁不動也要自動更新：定期重抓第一頁，只把「還沒顯示過」的新項目補在最前面、
  // 置頂區整組換新；不動使用者已載入的後續頁與捲動位置。節奏同其他用戶端卡片（lib/autoRefresh.ts），
  // 背景分頁暫停、切回前景立刻補抓（useLivePolling）。重抓失敗就保持畫面不變。
  // 第一次評估不抓：頁面剛由上面的初次載入抓過了，再抓一次是重複請求（2026-10-08 驗證抓到進頁就連發兩次）
  const pollArmed = useRef(false);
  useLivePolling({
    decide: (now) => {
      const fetch = pollArmed.current;
      pollArmed.current = true;
      return { fetch, settle: false, nextCheckMs: clientRefreshMs(now) };
    },
    onFetch: async () => {
      try {
        const res = await fetch(`/api/news-feed?offset=0&limit=${PAGE_LIMIT}`);
        if (!res.ok) return;
        const data: FeedResponse = await res.json();
        setPinned(data.pinned ?? []);
        setItems((prev) => {
          if (prev.length === 0) return prev; // 初次載入還沒完成，交給初次載入
          const seen = new Set(prev.map((i) => i.id));
          const fresh = data.items.filter((i) => !seen.has(i.id));
          return fresh.length > 0 ? [...fresh, ...prev] : prev;
        });
      } catch {
        // 保持畫面
      }
    },
  });

  // Recreated whenever `items`/`hasMore` change so the offset and cutoff it
  // captures are always current — this only re-runs on state changes that
  // happen a handful of times per session (each successful page load), not
  // per scroll event, so there's no meaningful cost to not memoizing harder.
  const loadMore = useCallback(() => {
    if (loadingRef.current || !hasMore) return;
    loadingRef.current = true;
    setLoadingMore(true);
    fetch(`/api/news-feed?offset=${items.length}&limit=${PAGE_LIMIT}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((data: FeedResponse) => {
        setItems((prev) => [...prev, ...data.items]);
        setHasMore(data.hasMore);
      })
      .catch(() => setHasMore(false))
      .finally(() => {
        loadingRef.current = false;
        setLoadingMore(false);
      });
  }, [items.length, hasMore]);

  // Infinite scroll: observe a sentinel div below the list and load the next
  // page once it scrolls into view. Re-subscribes whenever `loadMore`
  // changes (i.e. after each page load) — cheap, since re-registering an
  // IntersectionObserver on the same element is not a meaningful cost.
  useEffect(() => {
    const el = sentinelRef.current;
    // Also gated on the initial load having finished (`pinned !== null`):
    // on first mount the page is short enough that the sentinel can already
    // sit inside the 400px rootMargin, so without this the observer fired
    // loadMore() immediately — racing the initial-load effect's own fetch
    // of the same offset 0 and appending a duplicate first page once both
    // resolved (observed locally: 40 rendered items instead of 20).
    if (!el || !hasMore || pinned === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "400px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore, hasMore, pinned]);

  if (initialError) {
    return (
      <div className="rounded-lg border border-(--gridline) bg-(--surface-1) p-10 text-center">
        <p className="text-(--text-secondary)">新聞資訊目前無法取得，請稍後再試。</p>
      </div>
    );
  }

  return (
    // 新聞用詞常是一般意思（「融資」＝公司借款、「壓力」＝評價壓力），不套名詞說明避免誤導
    <div data-no-gloss className="space-y-6">
      {pinned && pinned.length > 0 && (
        <section>
          <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-(--text-primary)">🔥 重大焦點</h2>
          <ul className="space-y-2">
            {pinned.map((item) => (
              <li key={`pinned-${item.id}`}>
                <NewsFeedRow item={item} pinned />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        {pinned && pinned.length > 0 && <h2 className="mb-3 text-sm font-semibold text-(--text-primary)">最新資訊</h2>}
        {pinned === null ? (
          <FeedSkeleton />
        ) : items.length === 0 && !hasMore ? (
          <p className="py-8 text-center text-sm text-(--text-muted)">目前查不到相關新聞。</p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id}>
                <NewsFeedRow item={item} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div ref={sentinelRef} className="py-4 text-center text-xs text-(--text-muted)">
        {loadingMore ? "載入中…" : !hasMore && items.length > 0 ? "已經到底囉" : ""}
      </div>
    </div>
  );
}

/**
 * Deliberately NOT a clickable card — a user asked specifically that the
 * card show title/time/source and (for pinned items) a plain-language
 * summary as one block, with the actual outbound link as its own distinct
 * element at the bottom, rather than the whole row acting as a link that
 * navigates away on any click.
 */
function NewsFeedRow({ item, pinned }: { item: NewsFeedItem; pinned?: boolean }) {
  const isInternal = item.kind === "data";
  return (
    <div
      className={`rounded-lg border p-3 ${
        pinned ? "border-(--accent) bg-(--highlight-bg)" : "border-(--gridline) bg-(--surface-1)"
      }`}
    >
      <p className="text-sm font-medium text-(--text-primary)">{item.title}</p>
      {/* --text-muted (tuned against --surface-1) fails WCAG AA on the
          pinned card's --accent-soft background — 2.71:1 light / 2.26:1
          dark, an Opus QA pass measured and confirmed visually washed out.
          --text-secondary clears 4.5:1 against accent-soft in both themes
          (6.00:1 / 4.52:1) while still reading as secondary/muted next to
          the title. */}
      <p className={`mt-1 text-xs ${pinned ? "text-(--text-secondary)" : "text-(--text-muted)"}`}>
        {item.source ?? "來源不明"}
        {item.pubDate && ` · ${formatTaipeiDateTime(item.pubDate).slice(0, -3)}`}
      </p>
      {item.summary && (
        <p className="mt-2 text-sm text-(--text-primary)">
          {item.summary}
          {/* Only shown when the summary was genuinely written from the
              article's extracted body text (see newsfeed.ts summarizeBatch)
              — never claimed for the headline-only fallback, which is a
              plain paraphrase of the title and nothing more. */}
          {item.summaryKind === "fulltext" && (
            // A plain inline label styled with an icon read as a clickable
            // tag to at least one tester ("點擊沒有任何反應") — it isn't
            // meant to be interactive (see the card-level comment above),
            // so it's styled as a small pill/badge instead of inline text
            // to read as a passive label, with cursor-default making that
            // explicit rather than inheriting a pointer cursor from
            // anywhere else on the card.
            <span
              className="ml-1.5 inline-flex cursor-default select-none items-center gap-0.5 rounded-full bg-(--page-plane) px-1.5 py-0.5 align-middle text-[11px] font-normal text-(--text-muted)"
              title="摘要根據文章全文內容，不只是標題"
            >
              📄 全文摘要
            </span>
          )}
        </p>
      )}
      {item.link &&
        (isInternal ? (
          <Link href={item.link} className="mt-2 inline-block text-xs font-medium text-(--accent) hover:underline">
            查看個股頁面 →
          </Link>
        ) : (
          <a
            href={item.link}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-xs font-medium text-(--accent) hover:underline"
          >
            查看原文 ↗
          </a>
        ))}
    </div>
  );
}

function FeedSkeleton() {
  return (
    <ul className="space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="h-16 animate-pulse rounded-lg border border-(--gridline) bg-(--surface-1)" />
      ))}
    </ul>
  );
}
