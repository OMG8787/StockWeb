"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeNavHref, type NavItem } from "@/lib/navItems";

/**
 * 導覽列（桌機＋手機）。桌機：有子頁面的項目滑鼠移上去／鍵盤聚焦就展開選單，項目本身仍可直接點進主頁；
 * 手機：橫向捲動列，目前所在群組的子頁面另外顯示成第二排。
 * 目前所在的項目會加底色與粗體，使用者隨時知道自己在哪。
 */
export function DesktopNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const active = activeNavHref(pathname, items);
  return (
    <nav className="hidden sm:flex items-center gap-1 text-sm" aria-label="主選單">
      {items.map((item) => {
        const isActive = active === item.href;
        const hasMenu = !!item.children && item.children.length > 1;
        const link = (
          <Link
            href={item.href}
            prefetch={false}
            aria-current={isActive ? "page" : undefined}
            className={`flex items-center gap-1 rounded-md px-3 py-2 hover:bg-(--page-plane) hover:text-(--text-primary) ${
              isActive ? "bg-(--page-plane) font-semibold text-(--text-primary)" : "text-(--text-secondary)"
            }`}
          >
            {item.label}
            {hasMenu && (
              <span aria-hidden className="text-[10px] opacity-60">
                ▾
              </span>
            )}
          </Link>
        );
        if (!hasMenu) return <div key={item.href}>{link}</div>;
        return (
          // 選單緊貼在項目下方（沒有空隙），滑鼠從項目移到選單的途中不會斷掉
          <div key={item.href} className="group relative">
            {link}
            <div className="invisible absolute left-0 top-full z-50 min-w-64 opacity-0 transition-opacity duration-100 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
              <ul className="mt-0.5 rounded-lg border border-(--gridline) bg-(--surface-1) py-1 shadow-xl">
                {item.children!.map((c) => {
                  const here = pathname === c.href;
                  return (
                    <li key={c.href}>
                      <Link href={c.href} prefetch={false} className={`block px-3 py-2 hover:bg-(--page-plane) ${here ? "bg-(--page-plane)" : ""}`}>
                        <span className={`block ${here ? "font-semibold" : ""}`}>{c.label}</span>
                        <span className="block text-xs text-(--text-muted)">{c.desc}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        );
      })}
    </nav>
  );
}

export function MobileNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const active = activeNavHref(pathname, items);
  const group = items.find((i) => i.href === active && i.children && i.children.length > 1);
  return (
    <div className="sm:hidden">
      {/* 項目一多一行放不下，用橫向捲動保持每個標籤完整（不會從字中間斷行） */}
      <nav className="flex items-center gap-1 overflow-x-auto px-4 pb-2 text-sm" aria-label="主選單">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            prefetch={false}
            aria-current={active === item.href ? "page" : undefined}
            className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 hover:bg-(--page-plane) ${
              active === item.href ? "bg-(--page-plane) font-semibold text-(--text-primary)" : "text-(--text-secondary)"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {group?.children && (
        <nav className="flex items-center gap-1 overflow-x-auto border-t border-(--gridline) px-4 py-1.5 text-xs" aria-label={`${group.label}子頁面`}>
          {group.children.map((c) => (
            <Link
              key={c.href}
              href={c.href}
              prefetch={false}
              className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 hover:bg-(--page-plane) ${
                pathname === c.href ? "bg-(--page-plane) font-semibold" : "text-(--text-secondary)"
              }`}
            >
              {c.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
