"use client";

import { setChipsColumnsVisible, useChipsColumnsVisible } from "@/lib/chipsColumnsStore";

/**
 * 籌碼四欄（大戶／外資／融資／融券）一鍵顯示／隱藏。全站所有表格共用同一個狀態
 * （lib/chipsColumnsStore.ts），任何一個按鈕按下去，同頁所有表格即時一起變。
 */
export default function ChipsColumnsToggle({ className = "" }: { className?: string }) {
  const visible = useChipsColumnsVisible();
  return (
    <button
      type="button"
      onClick={() => setChipsColumnsVisible(!visible)}
      aria-pressed={visible}
      className={`rounded-md border px-2 py-0.5 text-xs whitespace-nowrap hover:bg-(--page-plane) ${
        visible ? "border-(--accent) bg-(--surface-2) text-(--accent)" : "border-(--gridline) bg-(--surface-2) text-(--text-secondary)"
      } ${className}`}
      aria-label={visible ? "隱藏籌碼欄位" : "顯示籌碼欄位"}
      title="點一下切換：一鍵同步顯示／隱藏大戶持股、外資持股、融資使用率、融券使用率四個籌碼欄位（全站所有表格一起變，記在這台裝置）"
    >
      籌碼欄位：{visible ? "顯示中" : "已隱藏"}
    </button>
  );
}
