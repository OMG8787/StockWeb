"use client";

import Link from "next/link";
import { fmtTime, ntd, pct, SIM_DISCLAIMER, tone, useSimPortfolio } from "./useSimPortfolio";

/** 首頁卡片顯示的持股與交易筆數。 */
const CARD_HOLDINGS = 4;
const CARD_TRADES = 3;

/**
 * 首頁「AI 模擬投資組合」卡：淨值、今日／累計報酬、對照 0050、持股前幾檔、最近交易；點進 /portfolio 看完整。
 * 2026-10-06 使用者：「一樣要顯示在首頁讓人能直接看到AI的成效表現。」
 */
export default function SimPortfolioCard() {
  const { data, failed } = useSimPortfolio(CARD_TRADES);
  const perf = data?.perf;
  return (
    <section className="rounded-lg border border-(--gridline) bg-(--surface-1) p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">🤖 AI 模擬投資組合</h2>
        <Link href="/portfolio" className="text-sm text-(--accent) hover:underline">
          查看完整持股與交易 →
        </Link>
      </div>
      {failed ? (
        <p className="mt-2 text-sm text-(--text-muted)">模擬投資組合目前無法取得，請稍後再試。</p>
      ) : !data ? (
        <div className="mt-3 h-28 animate-pulse rounded-md bg-(--page-plane)" aria-hidden />
      ) : !data.started || !perf ? (
        <p className="mt-2 text-sm text-(--text-secondary)">
          {data.enabled ? "下一個交易時點（09:30／13:00／13:35）開始自動建倉。" : "這個環境沒有設定資料庫，模擬投資組合未啟用。"}
        </p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="目前淨值" value={`${ntd(perf.nav)} 元`} />
            <Stat label="今日" value={pct(perf.dayReturnPct)} cls={tone(perf.dayReturnPct)} />
            <Stat label={`累計（${data.startDay} 起）`} value={pct(perf.totalReturnPct)} cls={tone(perf.totalReturnPct)} />
            <Stat
              label={`vs 0050（同期 0050 ${pct(perf.etfReturnPct)}，自建倉當下價格起算、非今日漲跌）`}
              value={perf.vsEtfPct == null ? "—" : `${perf.vsEtfPct > 0 ? "+" : ""}${perf.vsEtfPct.toFixed(2)} 點`}
              cls={tone(perf.vsEtfPct)}
            />
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="text-[13px] font-medium text-(--text-muted)">持股（{data.holdings?.length ?? 0} 檔，現金 {ntd(data.cash ?? 0)} 元）</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {(data.holdings ?? []).slice(0, CARD_HOLDINGS).map((h) => (
                  <li key={h.symbol} className="flex items-baseline justify-between gap-2">
                    <Link href={`/stock/${h.symbol}?market=TW`} className="truncate hover:text-(--accent)">
                      {h.name} <span className="text-(--text-muted) tabular-nums">{h.symbol}</span>
                      <span className="ml-1 text-[12px] text-(--text-muted)">{h.weightPct}%</span>
                    </Link>
                    <span className={`tabular-nums whitespace-nowrap ${tone(h.pnlPct)}`}>{pct(h.pnlPct)}</span>
                  </li>
                ))}
                {(data.holdings?.length ?? 0) === 0 && <li className="text-(--text-muted)">目前空手</li>}
              </ul>
            </div>
            <div>
              <h3 className="text-[13px] font-medium text-(--text-muted)">
                最近交易{(data.pending?.length ?? 0) > 0 && `（另有 ${data.pending!.length} 筆盤後定價委託，${data.rules.fixedFillTime} 成交）`}
              </h3>
              <ul className="mt-1 space-y-1 text-sm">
                {(data.trades ?? []).map((t, i) => (
                  <li key={`${t.at}-${t.symbol}-${i}`} className="flex items-baseline gap-2">
                    <span
                      className={`shrink-0 rounded px-1.5 text-[12px] ${
                        t.status === "rejected" ? "bg-(--page-plane) text-(--text-muted)" : t.side === "buy" ? "bg-(--price-up)/10 text-(--price-up)" : "bg-(--price-down)/10 text-(--price-down)"
                      }`}
                    >
                      {t.status === "rejected" ? "未成交" : t.side === "buy" ? "買" : "賣"}
                    </span>
                    <span className="truncate">
                      {t.name} {t.status === "rejected" ? (t.rejectReason ?? "").replace(/^未成交：/, "") : `${t.shares.toLocaleString("en-US")} 股 @ ${t.price}`}
                    </span>
                    <span className="ml-auto shrink-0 text-[12px] text-(--text-muted) tabular-nums">{fmtTime(t.at)}</span>
                  </li>
                ))}
                {(data.trades?.length ?? 0) === 0 && <li className="text-(--text-muted)">還沒有交易</li>}
              </ul>
            </div>
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-(--text-muted)">{SIM_DISCLAIMER}</p>
        </>
      )}
    </section>
  );
}

function Stat({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-md bg-(--page-plane) px-3 py-2">
      <div className="text-[12px] text-(--text-muted)">{label}</div>
      <div className={`mt-0.5 font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}
