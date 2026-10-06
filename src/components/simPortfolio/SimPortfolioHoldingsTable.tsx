"use client";

import Link from "next/link";
import type { SimHoldingView } from "@/lib/simPortfolio/view";
import { useChipsRatioRow } from "@/lib/useChipsRatios";
import { useChipsColumnsVisible } from "@/lib/chipsColumnsStore";
import { ChipsRatioCells, ChipsRatioHeaderCells } from "../ChipsRatioCells";
import ChipsColumnsToggle from "../ChipsColumnsToggle";
import StickyTableScroll from "../StickyTableScroll";
import WatchlistButton from "../WatchlistButton";
import { ntd, pct, tone } from "./useSimPortfolio";

const th = "py-2 pr-2.5 sm:pr-4 font-medium text-right whitespace-nowrap";
const td = "py-2.5 pr-2.5 sm:pr-4 text-right tabular-nums whitespace-nowrap";

/** 模擬組合持股表：沿用全站表格（固定表頭與名稱欄、可左右滑動）與籌碼四欄顯示／隱藏開關（跟關注清單同一個狀態）。 */
export default function SimPortfolioHoldingsTable({ holdings }: { holdings: SimHoldingView[] }) {
  const showChips = useChipsColumnsVisible();
  if (holdings.length === 0) return <p className="py-6 text-center text-sm text-(--text-muted)">目前空手（全部現金）。</p>;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-[13px] text-(--text-muted) xl:hidden">← 可左右滑動查看完整欄位，表頭與名稱欄會固定 →</p>
        <ChipsColumnsToggle className="ml-auto" />
      </div>
      <StickyTableScroll>
        <table className={`sticky-table w-full text-sm ${showChips ? "min-w-[1240px]" : "min-w-[860px]"}`}>
          <thead>
            <tr className="border-b border-(--gridline) text-left text-(--text-muted)">
              <th className="w-8" />
              <th className="sticky-name py-2 pr-2.5 sm:pr-4 font-medium whitespace-nowrap">代碼 / 名稱</th>
              <th className={th}>股數</th>
              <th className={th}>成本</th>
              <th className={th}>現價</th>
              <th className={th}>今日</th>
              <th className={th}>市值</th>
              <th className={th}>占比</th>
              <th className={th}>未實現損益</th>
              {showChips && <ChipsRatioHeaderCells />}
              <th className="py-2 pr-2.5 sm:pr-4 font-medium whitespace-nowrap">持有中評等／出場價</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => (
              <Row key={h.symbol} h={h} showChips={showChips} />
            ))}
          </tbody>
        </table>
      </StickyTableScroll>
    </>
  );
}

function Row({ h, showChips }: { h: SimHoldingView; showChips: boolean }) {
  const { rowRef, entry } = useChipsRatioRow(h.symbol, showChips ? "TW" : "US", { webFallback: true });
  return (
    <tr ref={rowRef} className="border-b border-(--gridline) last:border-0 hover:bg-(--page-plane)">
      <td className="py-2.5 pl-1">
        <WatchlistButton symbol={h.symbol} market="TW" name={h.name} />
      </td>
      <td className="sticky-name py-2.5 pr-2.5 sm:pr-4">
        <Link href={`/stock/${h.symbol}?market=TW`} className="font-medium hover:text-(--accent)">
          {h.name}
          <span className="ml-1.5 text-(--text-muted) tabular-nums">{h.symbol}</span>
        </Link>
        <div className="text-[12px] text-(--text-muted)">{h.buyDay} 買進</div>
      </td>
      <td className={td}>{h.shares.toLocaleString("en-US")}</td>
      <td className={td}>{h.avgCost}</td>
      <td className={td}>{h.price}</td>
      <td className={`${td} ${tone(h.changePercent)}`}>{pct(h.changePercent)}</td>
      <td className={td}>{ntd(h.marketValue)}</td>
      <td className={td}>{h.weightPct}%</td>
      <td className={`${td} ${tone(h.pnl)}`}>
        {ntd(h.pnl)}
        <span className="ml-1 text-[12px]">({pct(h.pnlPct)})</span>
      </td>
      {showChips && <ChipsRatioCells entry={entry} isTw />}
      <td className="py-2.5 pr-2.5 sm:pr-4 text-[13px] text-(--text-secondary)">
        {h.label ?? "—"}
        {h.stopPrice != null && <span className="ml-1 whitespace-nowrap text-(--text-muted)">跌破 {h.stopPrice} 出場</span>}
      </td>
    </tr>
  );
}
