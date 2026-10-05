"use client";

import { useSyncExternalStore } from "react";

/**
 * 「籌碼四欄」（大戶持股(週)／外資持股／融資使用率／融券使用率）全站共用的顯示開關。
 *
 * 使用者 2026-10-06 要求：四欄資訊太多，要能一鍵同步隱藏／展開，關注清單、首頁焦點、
 * /highlights、/search 都要，電腦與手機都要，且隱藏後版面要重排（欄位真的移除，不留白）。
 * 所以這是**唯一**的狀態來源：模組層級 store ＋ localStorage（per 裝置）＋ 同頁 listener
 * ＋ 跨分頁 storage 事件；所有表格都用 useChipsColumnsVisible() 讀，切換一次全部即時同步。
 * 預設顯示（沒存過、localStorage 不可用都當作顯示）。
 */
export const CHIPS_COLUMNS_STORAGE_KEY = "chips-columns-visible:v1";

let visible = true;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    visible = window.localStorage.getItem(CHIPS_COLUMNS_STORAGE_KEY) !== "0";
  } catch {
    // localStorage 不可用：維持預設顯示，本次瀏覽內切換仍有效。
  }
  window.addEventListener("storage", (e) => {
    if (e.key !== CHIPS_COLUMNS_STORAGE_KEY) return;
    const next = e.newValue !== "0";
    if (next !== visible) {
      visible = next;
      listeners.forEach((l) => l());
    }
  });
}

function subscribe(listener: () => void): () => void {
  load();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  load();
  return visible;
}

/** 伺服器端與水合第一次渲染一律當作「顯示」（跟預設一致，避免水合不符）。 */
function getServerSnapshot(): boolean {
  return true;
}

export function setChipsColumnsVisible(next: boolean): void {
  load();
  if (next === visible) return;
  visible = next;
  try {
    window.localStorage.setItem(CHIPS_COLUMNS_STORAGE_KEY, next ? "1" : "0");
  } catch {
    // 寫入失敗不影響本次瀏覽內的同步。
  }
  listeners.forEach((l) => l());
}

export function useChipsColumnsVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
