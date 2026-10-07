"use client";

import { useSyncExternalStore } from "react";
import { hasPerm, parsePerms, type PermCode } from "./permissions";

/**
 * 畫面用的登入者資料（讀 sw_profile cookie，見 sessionCookie.ts）。只用來決定
 * 顯示哪些選單／按鈕；真正的權限檢查在 proxy，竄改這個 cookie 不會多拿到任何東西。
 */
export interface Profile {
  name: string;
  account: string;
  perms: PermCode[];
  strategy: string;
  mustChangePassword: boolean;
}

let lastRaw: string | null = null;
let lastProfile: Profile | null = null;

function readProfile(): Profile | null {
  const m = document.cookie.match(/(?:^|;\s*)sw_profile=([^;]*)/);
  const raw = m ? m[1] : "";
  if (raw === lastRaw) return lastProfile;
  lastRaw = raw;
  try {
    const p = raw ? (JSON.parse(decodeURIComponent(raw)) as Profile) : null;
    lastProfile = p ? { ...p, perms: parsePerms(p.perms) } : null;
  } catch {
    lastProfile = null;
  }
  return lastProfile;
}

// cookie 沒有變更事件：切回分頁時重讀一次（權限被管理員調整後，proxy 會在下一次請求更新 cookie）
function subscribe(onChange: () => void) {
  window.addEventListener("focus", onChange);
  return () => window.removeEventListener("focus", onChange);
}

export function useProfile(): Profile | null {
  return useSyncExternalStore(subscribe, readProfile, () => null);
}

export function useHasPerm(need: readonly number[]): boolean {
  const p = useProfile();
  return p ? hasPerm(p.perms, need) : false;
}
