"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * 換頁時的載入遮罩（2026-10-08 使用者要求：「按下後還沒跑出來要做遮罩，但不能蓋到導覽列」）。
 *
 * 導覽連結都是 prefetch={false}，Next 要等伺服器回應才會換頁，期間畫面毫無反應，
 * 使用者會以為沒按到而重複點。這裡攔截站內連結的點擊（以及 startNavigating() 這種
 * 程式導頁），立刻在導覽列下方蓋一層遮罩＋轉圈；網址真的換了就收起來。
 * 遮罩從 header 底部開始（即時量測，捲動後 header 不在畫面上就從頂端開始），導覽列仍可點。
 */
export const NAV_START_EVENT = "stockradar:navigating";
/** 最多顯示這麼久（例如伺服器出錯沒換頁），避免永遠擋住畫面 */
const MAX_SHOW_MS = 90_000;
/** 很快就換好的頁面不閃一下遮罩 */
const SHOW_DELAY_MS = 150;

/** 程式導頁（router.push）前呼叫，讓遮罩一樣出現 */
export function startNavigating() {
  window.dispatchEvent(new Event(NAV_START_EVENT));
}

function isInternalNavigation(e: MouseEvent): boolean {
  // 不看 defaultPrevented：Next 的 <Link> 本來就會 preventDefault 再自己導頁
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  const a = (e.target as Element | null)?.closest?.("a");
  if (!a || !a.href || a.target === "_blank" || a.hasAttribute("download")) return false;
  const url = new URL(a.href, window.location.href);
  if (url.origin !== window.location.origin) return false;
  // 同一頁（只差 #錨點）不算換頁
  return url.pathname + url.search !== window.location.pathname + window.location.search;
}

export default function NavigationOverlay() {
  const pathname = usePathname();
  const [top, setTop] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 網址換了：取消還沒出現的遮罩、收起已出現的（setState 放在 timer 回呼裡，不在 effect 本體同步呼叫）
  useEffect(() => {
    clearTimeout(showTimer.current);
    const t = setTimeout(() => setTop(null), 0);
    return () => clearTimeout(t);
  }, [pathname]);

  useEffect(() => {
    function start() {
      clearTimeout(showTimer.current);
      showTimer.current = setTimeout(() => {
        const header = document.querySelector("header");
        setTop(Math.max(0, header ? header.getBoundingClientRect().bottom : 0));
        setStartedAt(Date.now());
      }, SHOW_DELAY_MS);
    }
    function onClick(e: MouseEvent) {
      if (isInternalNavigation(e)) start();
    }
    // 捕獲階段：比 <Link> 自己的處理先看到點擊
    document.addEventListener("click", onClick, true);
    window.addEventListener(NAV_START_EVENT, start);
    return () => {
      clearTimeout(showTimer.current);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener(NAV_START_EVENT, start);
    };
  }, []);

  useEffect(() => {
    if (top === null) return;
    const t = setTimeout(() => setTop(null), Math.max(0, MAX_SHOW_MS - (Date.now() - startedAt)));
    return () => clearTimeout(t);
  }, [top, startedAt]);

  if (top === null) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ top }}
      className="fixed inset-x-0 bottom-0 z-40 flex items-start justify-center bg-(--page-plane)/70 pt-24 backdrop-blur-[1px]"
    >
      <div className="flex items-center gap-3 rounded-xl border border-(--gridline) bg-(--surface-1) px-5 py-3 text-sm font-medium shadow-lg">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-(--gridline) border-t-(--accent)" />
        載入中…
      </div>
    </div>
  );
}
