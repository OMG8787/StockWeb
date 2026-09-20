"use client";

import { useRef, useState } from "react";
import { formatPrice } from "@/lib/format";
import type { MarketScope } from "@/lib/marketStatus";
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

  /**
   * 哪些提醒的標的是興櫃股（交易到 15:00，不是 13:30）。PriceAlert 本身只存
   * market（"TW"/"US"）沒有板別，所以跟關注清單一樣，抓報價時從 Quote.board
   * 順手記下來——掛載那一次一定會檢查一輪，之後的節奏判斷就有依據。
   */
  const emergingSymbols = useRef<Set<string>>(new Set());
  const scopeOf = (a: PriceAlert): MarketScope =>
    a.market === "TW" && emergingSymbols.current.has(a.symbol.toUpperCase()) ? "TW-EMERGING" : a.market;

  useLivePolling({
    fetchOnMount: true,
    decide: (now, settledDayKey) => {
      const scopes: MarketScope[] = ["TW", "US"];
      // 只有真的還有「未觸發的興櫃提醒」時才把興櫃時段納入，否則 13:30~15:00
      // 這段會為了不存在的興櫃提醒白白每 30 秒空轉檢查一次。
      if (getAlerts().some((a) => !a.triggered && scopeOf(a) === "TW-EMERGING")) scopes.push("TW-EMERGING");
      return mergePollDecisions(
        scopes.map((s) => getPollDecision(s, now, settledDayKey)),
        ALERT_MIN_CHECK_MS
      );
    },
    onFetch: async (ctx) => {
      const pending = getAlerts().filter(
        (a) => !a.triggered && shouldRefreshSymbol(scopeOf(a), ctx.now, ctx)
      );
      if (pending.length === 0) return;
      const fired: PriceAlert[] = [];
      for (const alert of pending) {
        try {
          const res = await fetch(`/api/quote/${encodeURIComponent(alert.symbol)}?market=${alert.market}`);
          if (!res.ok) continue;
          const quote = await res.json();
          // 記下興櫃檔，下一輪的節奏判斷才知道它交易到 15:00（見上面 scopeOf）。
          if (quote?.board === "emerging") emergingSymbols.current.add(alert.symbol.toUpperCase());
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
