"use client";

import { useState } from "react";
import type { Quote } from "@/lib/data";
import { formatChange, formatPercent, formatPrice, formatTaipeiDateTime, formatVolume, priceDirectionClass } from "@/lib/format";
import { getMarketStatus, type MarketStatus } from "@/lib/marketStatus";
import { getPollDecision } from "@/lib/pollingSchedule";
import { useLivePolling } from "@/lib/useLivePolling";
import MarketStatusBadge from "./MarketStatusBadge";

/**
 * Renders the price header + stat grid, seeded from the server-fetched
 * quote and then kept live. 刷新節奏統一交給 lib/pollingSchedule.ts：台股在
 * 08:30~14:30 每 10 秒刷新，收盤後停止輪詢並在 14:40 補抓一次最終收盤數字；
 * 美股維持原本「盤中每 20 秒」的邏輯。非交易時段就顯示最近一次可得的資料
 * （getQuote 本來就會回上一個收盤價），並持續檢查是否已經跨進交易時段，
 * 所以一直開著的頁面到了開盤會自己開始更新。
 */
export default function LiveQuoteHeader({ initialQuote }: { initialQuote: Quote }) {
  const { symbol, market } = initialQuote;
  const [quote, setQuote] = useState(initialQuote);
  const [status, setStatus] = useState<MarketStatus>(() => getMarketStatus(market));

  useLivePolling({
    restartKey: `${market}:${symbol}`,
    decide: (now, settledDayKey) => {
      setStatus(getMarketStatus(market, now));
      return getPollDecision(market, now, settledDayKey);
    },
    onFetch: async () => {
      const res = await fetch(`/api/quote/${encodeURIComponent(symbol)}?market=${market}`);
      if (!res.ok) return;
      const next: Quote = await res.json();
      setQuote(next);
    },
  });

  return (
    <>
      <div className="mt-3 flex flex-wrap items-baseline gap-3">
        <span className="text-4xl font-bold tabular-nums">{formatPrice(quote.price, quote.currency)}</span>
        <span className={`text-lg font-semibold tabular-nums ${priceDirectionClass(quote.change)}`}>
          {quote.change > 0 ? "▲" : quote.change < 0 ? "▼" : "–"} {formatChange(quote.change, quote.currency)} (
          {formatPercent(quote.changePercent)})
        </span>
        <MarketStatusBadge status={status} />
      </div>
      <p className="mt-1 text-xs text-(--text-muted)">
        更新時間：{formatTaipeiDateTime(quote.updatedAt)}（台北時間）· 幣別{" "}
        {quote.currency}
        {status === "closed" && "（非交易時段，顯示最近一次收盤資訊）"}
        {status === "pre-market" && "（08:30-09:00試搓時段，尚未正式開盤，以下數字僅供參考）"}
      </p>

      {/* 興櫃專屬說明。興櫃跟上市/上櫃是完全不同的交易制度，如果不講清楚，
          使用者會用看上市股的習慣去解讀這頁的每一個數字（尤其是「漲跌是跟
          什麼比」跟「為什麼沒有開盤價」）。 */}
      {quote.board === "emerging" && (
        <p className="mt-2 rounded-md bg-(--surface-2) px-3 py-2 text-xs leading-relaxed text-(--text-secondary)">
          <span className="font-semibold text-(--text-primary)">興櫃股票</span>
          ：興櫃是公司正式上市櫃之前的階段，用「議價」方式跟券商一對一談價格成交，不是像上市櫃那樣集中撮合。所以它
          <span className="font-semibold">沒有開盤價、也沒有收盤價</span>
          ，漲跌是拿最近成交價跟「前日均價」比出來的，而且
          <span className="font-semibold">沒有漲跌幅上下限</span>
          ，一天漲跌好幾成都可能發生，成交量通常也很少。
          {quote.priceNote && <span className="mt-1 block">※ {quote.priceNote}。</span>}
        </p>
      )}

      <dl className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
        <Stat label="開盤" value={priceOrDash(quote.open, quote.currency)} />
        <Stat label="最高" value={priceOrDash(quote.high, quote.currency)} valueClass="text-(--price-up)" />
        <Stat label="最低" value={priceOrDash(quote.low, quote.currency)} valueClass="text-(--price-down)" />
        <Stat label={quote.prevCloseLabel ?? "昨收"} value={formatPrice(quote.prevClose, quote.currency)} />
        <Stat label="成交量" value={formatVolume(quote.volume, quote.market)} />
      </dl>
    </>
  );
}

/** 開盤/最高/最低這三個欄位對興櫃可能真的不存在（見 types.ts 的 Quote.open
 *  說明）——沒有就顯示「—」，不是顯示 0，也不是拿別的數字頂替。 */
function priceOrDash(value: number | null, currency: string): string {
  return value == null ? "—" : formatPrice(value, currency);
}

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <dt className="text-(--text-muted)">{label}</dt>
      <dd className={`mt-0.5 font-medium tabular-nums ${valueClass ?? ""}`}>{value}</dd>
    </div>
  );
}
