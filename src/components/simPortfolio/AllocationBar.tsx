"use client";

import type { SimHoldingView } from "@/lib/simPortfolio/view";
import { ntd, pct } from "./useSimPortfolio";

/**
 * 持股比例圖（2026-10-12 使用者：「新增說明持股比例圖表，讓使用者看到這樣就會知道現在 AI 持股狀態，鼠標滑過去也要可以看到說明」）：
 * 一條橫向堆疊長條＝整個組合淨值 100%，每一段是一檔持股占淨值的比例，最後一段灰色是現金；
 * 下方圖例列出每檔占比。滑鼠移到任何一段或圖例都會顯示該檔的市值、占比與未實現損益。
 */
const COLORS = ["#4f8ef7", "#f59e0b", "#10b981", "#a855f7", "#ef4444", "#14b8a6", "#ec4899", "#84cc16", "#f97316", "#6366f1"];
const CASH_COLOR = "#6b7280";

const signed = (v: number) => `${v > 0 ? "+" : ""}${ntd(v)}`;

export default function AllocationBar({ holdings, cash, nav }: { holdings: SimHoldingView[]; cash: number; nav: number }) {
  const investedPct = holdings.reduce((s, h) => s + h.weightPct, 0);
  const cashPct = Math.max(0, 100 - investedPct);
  const segments = [
    ...holdings.map((h, i) => ({
      key: h.symbol,
      label: `${h.name} ${h.symbol}`,
      pct: h.weightPct,
      color: COLORS[i % COLORS.length],
      tip: `${h.name} ${h.symbol}\n占組合淨值 ${h.weightPct}%（市值 ${ntd(h.marketValue)} 元）\n未實現損益 ${signed(h.pnl)} 元（${pct(h.pnlPct)}，現價相對平均成本 ${h.avgCost}）`,
    })),
    { key: "cash", label: "現金", pct: cashPct, color: CASH_COLOR, tip: `現金 ${ntd(cash)} 元\n占組合淨值 ${cashPct.toFixed(1)}%（還沒投入的部分，等下一個交易時點買進）` },
  ];
  return (
    <div className="mt-4">
      <h3 className="text-[13px] font-medium text-(--text-muted)" title="整條長條＝淨值 100%；每一段是一檔持股占淨值的比例，灰色是現金。">
        持股比例（已投入 {investedPct.toFixed(1)}%・現金 {cashPct.toFixed(1)}%，淨值 {ntd(nav)} 元）
      </h3>
      <div className="mt-1 flex h-4 w-full overflow-hidden rounded bg-(--page-plane)" role="img" aria-label={`持股比例：已投入 ${investedPct.toFixed(1)}%，現金 ${cashPct.toFixed(1)}%`}>
        {segments.map((s) => (
          <div key={s.key} title={s.tip} style={{ width: `${s.pct}%`, backgroundColor: s.color }} className="h-full border-r border-(--surface-1) last:border-r-0" />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-(--text-secondary)">
        {segments.map((s) => (
          <li key={s.key} title={s.tip} className="flex cursor-default items-center gap-1 whitespace-nowrap">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
            {s.label}
            <span className="tabular-nums text-(--text-muted)">{s.pct.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
