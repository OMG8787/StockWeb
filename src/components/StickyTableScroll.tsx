"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * 全站表格（關注清單 WatchlistTable、StockTable＝首頁焦點／/highlights／/search）共用的捲動容器。
 * 樣式在 globals.css 的 .sticky-scroll／.sticky-table／.sticky-name：
 * - 桌機 >=1280px：不當捲動容器（overflow:visible），表頭 sticky 相對整頁；
 * - 手機／平板 <1280px：容器自己雙向捲動＋上限高度，表頭與名稱欄 sticky 相對容器。
 *
 * 方向鎖定（使用者 2026-10-06：上下滑動會帶動左右）：手指按下後依前 8px 的位移判斷主要方向，
 * 在容器上標 data-axis="x|y"，CSS 把另一軸暫時設 overflow:hidden，手指離開並停一小段時間後才解除
 * （保留慣性滑動）。CSS touch-action 無法做「單軸鎖定」（只能限制可用方向、且開始後不能改），
 * 所以用這個輕量 JS；不攔截事件（passive），瀏覽器原生捲動手感與慣性維持。
 */
const LOCK_SLOP_PX = 8;
const RELEASE_DELAY_MS = 700;

export default function StickyTableScroll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let startX = 0;
    let startY = 0;
    let decided = false;
    let tracking = false;
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;

    const clearAxis = () => {
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = null;
      el.removeAttribute("data-axis");
    };
    const onStart = (e: TouchEvent) => {
      clearAxis();
      // 拖曳把手（touch-action:none）與輸入框、按鈕上開始的觸控不是捲動手勢，不做方向鎖定。
      const target = e.target instanceof Element ? e.target : null;
      if (e.touches.length !== 1 || target?.closest("button, input, select, a")) {
        tracking = false;
        return;
      }
      tracking = true;
      decided = false;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking || decided) return;
      const t = e.touches[0];
      const dx = Math.abs(t.clientX - startX);
      const dy = Math.abs(t.clientY - startY);
      if (dx < LOCK_SLOP_PX && dy < LOCK_SLOP_PX) return;
      decided = true;
      el.setAttribute("data-axis", dy >= dx ? "y" : "x");
    };
    const onEnd = () => {
      tracking = false;
      if (!el.hasAttribute("data-axis")) return;
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = setTimeout(clearAxis, RELEASE_DELAY_MS);
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      clearAxis();
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  return (
    <div ref={ref} className="sticky-scroll">
      {children}
    </div>
  );
}
