"use client";

import Link from "next/link";
import { useState } from "react";
import { isAdmin } from "@/lib/auth/permissions";
import { useProfile } from "@/lib/auth/useProfile";

export default function UserMenu() {
  const profile = useProfile();
  const [open, setOpen] = useState(false);

  if (!profile) return null;

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 刻意整頁重載：登入狀態改變後要丟掉路由快取
    window.location.href = "/login";
  }

  const item = "block w-full px-3 py-2 text-left text-sm hover:bg-(--page-plane)";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full border border-(--gridline) bg-(--surface-2) py-1 pl-1 pr-2 text-sm hover:bg-(--page-plane)"
        title={profile.account}
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-(--accent) text-xs text-white">
          {profile.name.slice(0, 1) || "?"}
        </span>
        <span className="hidden max-w-24 truncate sm:inline">{profile.name}</span>
      </button>
      {open && (
        <>
          <button type="button" aria-label="關閉選單" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-md border border-(--gridline) bg-(--surface-1) shadow-lg">
            <div className="border-b border-(--gridline) px-3 py-2 text-xs text-(--text-muted)">
              {profile.name}
              <br />
              {profile.account}
            </div>
            <Link href="/account" className={item} onClick={() => setOpen(false)}>
              ⚙️ 帳號設定
            </Link>
            {isAdmin(profile.perms) && (
              <Link href="/admin" className={item} onClick={() => setOpen(false)}>
                👥 帳號與權限
              </Link>
            )}
            <button type="button" className={item} onClick={handleLogout}>
              🚪 登出
            </button>
          </div>
        </>
      )}
    </div>
  );
}
