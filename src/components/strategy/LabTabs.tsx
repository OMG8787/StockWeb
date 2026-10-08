import Link from "next/link";

/** 模擬倉／策略庫／參考指標三頁共用的切換列 */
const TABS = [
  { href: "/sim", label: "📈 模擬倉" },
  { href: "/strategies", label: "🧠 策略庫" },
  { href: "/strategies/compare", label: "📊 策略疊圖" },
  { href: "/strategies/alerts", label: "🔔 即時提醒" },
  { href: "/indicators", label: "📐 參考指標" },
];

export default function LabTabs({ active, intro }: { active: string; intro: string }) {
  return (
    <div className="space-y-2">
      <div data-no-gloss className="flex gap-1 overflow-x-auto border-b border-(--gridline)">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            prefetch={false}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${active === t.href ? "border-(--accent) font-semibold" : "border-transparent text-(--text-secondary)"}`}
          >
            {t.label}
          </Link>
        ))}
      </div>
      <p className="text-sm text-(--text-muted)">{intro}</p>
    </div>
  );
}
