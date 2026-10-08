"use client";

import { useEffect, useState } from "react";

/** 今日建議／每日快報卡片載入中的灰條；等超過 10 秒加一句說明，不讓人以為壞了。 */
const SLOW_HINT_MS = 10_000;

export default function BriefSkeleton({ lines }: { lines: number }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_HINT_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="space-y-2 py-1">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-3.5 animate-pulse rounded bg-(--page-plane)" style={{ width: `${85 - i * 8}%` }} />
      ))}
      {slow && <p className="pt-1 text-xs text-(--text-muted)">正在逐檔計算評等與價位，資料剛過期時第一次需要 1～2 分鐘，請稍候…</p>}
    </div>
  );
}
