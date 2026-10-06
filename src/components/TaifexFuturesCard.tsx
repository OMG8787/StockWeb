"use client";

import { useState } from "react";
import type { TaifexFuturesQuote } from "@/lib/data";
import { formatPercent, formatPrice, priceDirectionClass } from "@/lib/format";
import { getTaifexPollDecision, IDLE_CHECK_MS } from "@/lib/pollingSchedule";
import { useLivePolling } from "@/lib/useLivePolling";
import { livePollInit } from "@/lib/livePoll";

/**
 * 首頁「大盤指數」卡片旁的台指期夜盤（近月合約）小卡。刻意跟 LiveIndices/IndexCard
 * 分開一個元件（而不是塞進同一個 grid 共用 IndexCard），因為這張卡片必須額外顯示
 * 「交易中」／「已收盤（最近一次夜盤收盤）」的狀態徽章跟資料時間，避免使用者在
 * 非夜盤時段誤以為看到的是即時報價——這是台指期期貨資料（跟現貨指數不同）特有的
 * 誠實揭露需求。抓不到資料時顯示「資料暫缺」，絕不用其他數字頂替。
 *
 * 輪詢邏輯也刻意跟 LiveIndices 不同：這是盤後夜間商品，完全不適用台股日盤
 * 08:30~14:30 每 10 秒、14:40 補抓那套規則（台股日盤時段內，這張卡顯示的
 * 前一晚夜盤收盤價根本不會變）。改用夜盤自己的時段（週一~五 15:00~次日 05:00，
 * 見 lib/pollingSchedule.ts 的 getTaifexPollDecision）：夜盤期間每 20 秒刷新，
 * 其餘時間只在掛載時抓一次就停，不再空打 API。
 * 「交易中」/「已收盤」的徽章仍然完全依賴後端回傳的真實狀態，本站自己猜的
 * 時段只用來決定要不要發請求，絕不用來覆寫顯示狀態。
 */
export default function TaifexFuturesCard({ initialQuote }: { initialQuote: TaifexFuturesQuote | null }) {
  const [quote, setQuote] = useState(initialQuote);

  useLivePolling({
    fetchOnMount: true,
    // 夜盤時段以外本來就不用一直打 API，但如果目前根本沒有資料（SSR 那次抓失敗，
    // 畫面顯示「資料暫缺」），就每分鐘重試一次，不要讓使用者非得重新整理頁面
    // 才可能救回來。
    decide: (now) =>
      quote === null
        ? { fetch: true, settle: false, nextCheckMs: IDLE_CHECK_MS }
        : getTaifexPollDecision(now),
    onFetch: async (ctx) => {
      const res = await fetch("/api/taifex-futures", livePollInit(ctx));
      if (!res.ok) return;
      const data = await res.json();
      setQuote(data.quote ?? null);
    },
  });

  if (!quote) {
    return (
      <div className="rounded-lg border border-(--gridline) bg-(--surface-1) p-4">
        <p className="text-sm text-(--text-secondary)">台指期夜盤</p>
        <p className="mt-1 text-sm text-(--text-muted)">資料暫缺</p>
      </div>
    );
  }

  const statusLabel = quote.status === "trading" ? "夜盤交易中" : quote.status === "closed" ? "已收盤" : "特殊狀態";
  const statusClass =
    quote.status === "trading"
      ? "bg-(--accent-soft) text-(--accent)"
      : "bg-(--page-plane) text-(--text-muted)";

  return (
    <div className="rounded-lg border border-(--gridline) bg-(--surface-1) p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-(--text-secondary)">{quote.contractLabel}</p>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium ${statusClass}`}>
          <span
            className={`h-1.5 w-1.5 rounded-full ${quote.status === "trading" ? "bg-(--accent) animate-pulse" : "bg-(--text-muted)"}`}
            aria-hidden
          />
          {statusLabel}
        </span>
      </div>
      {/* formatPrice 的 "USD" 分支給 2 位小數，跟 IndexCard 對 TAIEX 指數點位的用法一致
          （這裡是指數式的期貨點位，不是個股股價，不套用 TWD 分支的「股價≥100元才1位小數」規則）。*/}
      <p className="mt-1 text-2xl font-semibold tabular-nums">{formatPrice(quote.price, "USD")}</p>
      <p className={`mt-1 text-sm font-medium tabular-nums ${priceDirectionClass(quote.change)}`}>
        {quote.change > 0 ? "▲" : quote.change < 0 ? "▼" : "–"} {formatPrice(Math.abs(quote.change), "USD")} (
        {formatPercent(quote.changePercent)})
      </p>
      {quote.asOf && (
        <p className="mt-1 text-[12px] text-(--text-muted)">
          {quote.status === "closed" ? "最近一次夜盤收盤，資料時間 " : "資料時間 "}
          {quote.asOf}
        </p>
      )}
    </div>
  );
}
