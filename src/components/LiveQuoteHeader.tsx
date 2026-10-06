"use client";

import { useState, type ReactNode } from "react";
import type { Quote } from "@/lib/data";
import { formatChange, formatPercent, formatPrice, formatTaipeiDateTime, formatTaipeiTime, formatVolume, priceDirectionClass } from "@/lib/format";
import { getMarketStatus, marketScope, type MarketStatus } from "@/lib/marketStatus";
import { getPollDecision } from "@/lib/pollingSchedule";
import { useLivePolling } from "@/lib/useLivePolling";
import { livePollInit } from "@/lib/livePoll";
import MarketStatusBadge from "./MarketStatusBadge";

/**
 * Renders the price header + stat grid, seeded from the server-fetched
 * quote and then kept live. 刷新節奏統一交給 lib/pollingSchedule.ts：台股在
 * 08:30~14:30 每 10 秒刷新，收盤後停止輪詢並在 14:40 補抓一次最終收盤數字；
 * 美股維持原本「盤中每 20 秒」的邏輯；興櫃則走自己的 09:00~15:00 時段。
 * 非交易時段就顯示最近一次可得的資料
 * （getQuote 本來就會回上一個收盤價），並持續檢查是否已經跨進交易時段，
 * 所以一直開著的頁面到了開盤會自己開始更新。
 */
/**
 * afterPrice：插在「價格＋更新時間」與「開高低收成交量」格子之間的內容（伺服器端傳進來的
 * 籌碼比例摘要）。手機螢幕小，如果放在整個報價區塊（含開高低收格子）下面，第一屏只看得到
 * 標題跟融資使用率；放在價格正下方，三項比例在手機第一屏就能一眼看完。
 */
export default function LiveQuoteHeader({ initialQuote, afterPrice }: { initialQuote: Quote; afterPrice?: ReactNode }) {
  const { symbol, market } = initialQuote;
  const [quote, setQuote] = useState(initialQuote);
  // 興櫃（board === "emerging"）的交易時間是 09:00~15:00，跟上市櫃的
  // 09:00~13:30 不同，所以狀態徽章與輪詢節奏都要用 "TW-EMERGING" 這個 scope
  // 判斷，否則 13:30~15:00 這段興櫃還在交易的時間會誤顯示「已收盤」、也不會
  // 自動更新報價。板別是股票本身的屬性、不會在頁面存活期間改變，所以用
  // initialQuote.board 算一次就好。
  const scope = marketScope(market, initialQuote.board);
  const emerging = scope === "TW-EMERGING";
  const [status, setStatus] = useState<MarketStatus>(() => getMarketStatus(scope));

  useLivePolling({
    restartKey: `${scope}:${symbol}`,
    decide: (now, settledDayKey) => {
      setStatus(getMarketStatus(scope, now));
      return getPollDecision(scope, now, settledDayKey);
    },
    onFetch: async (ctx) => {
      const res = await fetch(`/api/quote/${encodeURIComponent(symbol)}?market=${market}`, livePollInit(ctx));
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
        {/* 資料時間＝上游最近一筆成交時間（tradeTime）；updatedAt 只是伺服器抓取當下，看不出資料多舊，
            所以兩者並列。上游沒給成交時間（今日尚無成交、盤後日行情）就只顯示更新時間。 */}
        {quote.tradeTime ? (
          <>
            資料時間：{formatTaipeiDateTime(quote.tradeTime)}（最近一筆成交，台北時間）· 伺服器更新{" "}
            {formatTaipeiTime(quote.updatedAt)} · 幣別{" "}
          </>
        ) : (
          <>更新時間：{formatTaipeiDateTime(quote.updatedAt)}（台北時間）· 幣別{" "}</>
        )}
        {quote.currency}
        {/* 興櫃沒有收盤價這個東西（見下方說明區塊），所以收盤時段的措辭不能講
            「最近一次收盤資訊」；另外興櫃交易到 15:00，使用者在 14:00 看到
            「盤中」會跟上市櫃的習慣衝突，直接把交易時間寫出來最不會誤會。 */}
        {status === "closed" && !emerging && "（非交易時段，顯示最近一次收盤資訊）"}
        {status === "closed" && emerging && "（非交易時段，顯示最近一次成交資訊。興櫃交易時間為 09:00-15:00）"}
        {status === "open" && emerging && "（興櫃交易時間為 09:00-15:00，比上市櫃晚 1.5 小時收盤）"}
        {status === "pre-market" && "（08:30-09:00試撮時段，尚未正式開盤，以下數字僅供參考）"}
      </p>

      {afterPrice}

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
        </p>
      )}

      {/* priceNote 之前寫在上面 emerging 專屬區塊裡面，導致上市/上櫃股票
          （twse.ts/tpex.ts 在成交量 0 時附的中價估算揭露）永遠顯示不出來——
          quote.board 對這兩種股票根本不是 "emerging"，整段條件式直接跳過。
          Playwright 實測抓到：3632 研勤的 API 回應確實有 priceNote，但畫面
          上完全看不到任何說明文字。改成獨立區塊、不綁 board，任何市場的
          priceNote 都能顯示。 */}
      {quote.priceNote && (
        <p className="mt-2 text-xs text-(--text-secondary)">※ {quote.priceNote}。</p>
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
