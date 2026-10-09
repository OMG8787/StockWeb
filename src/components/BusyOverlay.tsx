"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { getBusyState, getServerBusyState, subscribeBusy } from "@/components/strategy/api";

/**
 * 「處理中」遮罩（2026-10-08 使用者要求：運作時要做遮罩或提示運作中）。
 * 儲存、新增、刪除、下單、預覽、比對等寫入類操作進行時，在導覽列下方蓋一層遮罩＋轉圈，
 * 擋住重複點擊（資料庫偶爾慢到 10～40 秒，重複按會重複新增）；導覽列仍可點。
 * 很快完成的操作（0.2 秒內）不閃一下；拖久了會逐步說明「還在處理、請勿重複按」。
 */
const SHOW_DELAY_MS = 200;
const SLOW_MS = 8_000;
const VERY_SLOW_MS = 30_000;

export default function BusyOverlay() {
  const busy = useSyncExternalStore(subscribeBusy, getBusyState, getServerBusyState);
  const [shown, setShown] = useState(false);
  const [top, setTop] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const active = busy.count > 0;

  useEffect(() => {
    if (!active) {
      const t = setTimeout(() => setShown(false), 0);
      return () => clearTimeout(t);
    }
    const startedAt = Date.now();
    const show = setTimeout(() => {
      const header = document.querySelector("header");
      setTop(Math.max(0, header ? header.getBoundingClientRect().bottom : 0));
      setElapsed(0);
      setShown(true);
    }, SHOW_DELAY_MS);
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => {
      clearTimeout(show);
      clearInterval(timer);
    };
  }, [active]);

  if (!active || !shown) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ top }}
      className="fixed inset-x-0 bottom-0 z-[45] flex items-start justify-center bg-(--page-plane)/70 pt-24 backdrop-blur-[1px]"
    >
      <div className="max-w-sm space-y-1 rounded-xl border border-(--gridline) bg-(--surface-1) px-5 py-3 text-sm shadow-lg">
        <div className="flex items-center gap-3 font-medium">
          <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-(--gridline) border-t-(--accent)" />
          {busy.text}
        </div>
        {elapsed > SLOW_MS && (
          <p className="text-xs text-(--text-secondary)">
            {elapsed > VERY_SLOW_MS ? "還在處理中（已超過 30 秒），完成後畫面會自動更新。請不要重複按。" : "這次花比較久（可能在即時抓行情或計算），請稍等、不要重複按，完成後畫面會自動更新。"}
          </p>
        )}
      </div>
    </div>
  );
}
