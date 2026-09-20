"use client";

import { useState } from "react";
import { formatPrice } from "@/lib/format";
import { getPollDecision, mergePollDecisions, shouldRefreshSymbol } from "@/lib/pollingSchedule";
import { useLivePolling } from "@/lib/useLivePolling";
import { getAlerts, markTriggered, type PriceAlert } from "@/lib/priceAlerts";

/**
 * 到價提醒的檢查間隔下限。刻意不跟著報價畫面一起縮到 10 秒：每一筆待觸發的
 * 提醒都是一次獨立的 /api/quote 請求，設了 5 筆提醒就等於每輪 5 個請求，
 * 而「漲到目標價」晚 30 秒通知跟晚 10 秒通知對使用者的實際差別很小。
 * 30 秒維持改動前的節奏，只是現在會跟著交易時段自動停止。
 */
const ALERT_MIN_CHECK_MS = 30_000;

/**
 * Mounted once in the root layout (alongside ChatWidget) rather than on the
 * stock page itself: an alert set on one stock needs to keep being checked
 * while the visitor is browsing other pages of the site, not just while
 * that one stock's page happens to be open.
 *
 * 檢查時機同樣交給 lib/pollingSchedule.ts：台股提醒只在 08:30~14:30 檢查
 * （外加 14:40 收盤補一次），美股提醒只在美股盤中檢查——收盤後價格根本不會
 * 再變動，繼續每 30 秒打 API 純粹是浪費。
 */
export default function PriceAlertWatcher() {
  const [firedNow, setFiredNow] = useState<PriceAlert[]>([]);

  useLivePolling({
    fetchOnMount: true,
    decide: (now, settledDayKey) =>
      mergePollDecisions(
        [getPollDecision("TW", now, settledDayKey), getPollDecision("US", now, settledDayKey)],
        ALERT_MIN_CHECK_MS
      ),
    onFetch: async (ctx) => {
      const pending = getAlerts().filter(
        (a) => !a.triggered && shouldRefreshSymbol(a.market, ctx.now, ctx)
      );
      if (pending.length === 0) return;
      const fired: PriceAlert[] = [];
      for (const alert of pending) {
        try {
          const res = await fetch(`/api/quote/${encodeURIComponent(alert.symbol)}?market=${alert.market}`);
          if (!res.ok) continue;
          const quote = await res.json();
          const hit =
            alert.condition === "above" ? quote.price >= alert.targetPrice : quote.price <= alert.targetPrice;
          if (hit) fired.push(alert);
        } catch {
          // best-effort; try again next poll
        }
      }
      if (fired.length === 0) return;
      fired.forEach((a) => markTriggered(a.id));
      setFiredNow((prev) => [...prev, ...fired]);
    },
  });

  if (firedNow.length === 0) return null;

  return (
    <div className="fixed bottom-24 right-4 z-50 space-y-2">
      {firedNow.map((a) => (
        <div
          key={a.id}
          className="flex items-center gap-3 rounded-lg border border-(--gridline) bg-(--surface-1) px-4 py-3 shadow-xl"
        >
          <span className="text-lg">🔔</span>
          <p className="text-sm">
            <span className="font-medium">{a.name}（{a.symbol}）</span>
            {a.condition === "above" ? "漲到" : "跌到"} {formatPrice(a.targetPrice, a.market === "TW" ? "TWD" : "USD")} 了
          </p>
          <button
            onClick={() => setFiredNow((prev) => prev.filter((x) => x.id !== a.id))}
            className="text-(--text-muted) hover:text-(--text-primary)"
            aria-label="關閉提醒"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
