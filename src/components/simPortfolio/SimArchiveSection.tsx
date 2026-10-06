"use client";

import { useEffect, useMemo, useState } from "react";
import type { SimArchivedTrade, SimDecisionRecord } from "@/lib/simPortfolio/archive";
import { fmtTime, pct } from "./useSimPortfolio";

/** 從開始月份到本月（新到舊）。 */
function monthsSince(startDay: string): string[] {
  const out: string[] = [];
  const now = new Date(Date.now() + 8 * 3600_000);
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth() + 1;
  const [sy, sm] = startDay.slice(0, 7).split("-").map(Number);
  while (y > sy || (y === sy && m >= sm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m--;
    if (m === 0) {
      m = 12;
      y--;
    }
  }
  return out;
}

type Tab = "trades" | "decisions";

/**
 * /portfolio「完整紀錄」：永久封存（每筆交易含未成交與決策快照、每個時點的決策紀錄），按月載入。
 * 2026-10-06 使用者：「每天且每筆交易記錄、原因等都有全部記下來嗎?方便不斷優化與進步。」
 */
export default function SimArchiveSection({ startDay }: { startDay: string }) {
  const months = useMemo(() => monthsSince(startDay), [startDay]);
  const [month, setMonth] = useState(months[0]);
  const [tab, setTab] = useState<Tab>("trades");
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ key: string; items: unknown[] } | null>(null);
  const [error, setError] = useState(false);
  const key = `${tab}:${month}`;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch(`/api/sim-portfolio/archive?kind=${tab}&month=${month}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { items: unknown[] }) => {
        if (alive) {
          setData({ key, items: j.items });
          setError(false);
        }
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [open, tab, month, key]);

  const items = data?.key === key ? data.items : null;
  const btn = (active: boolean) =>
    `rounded-md px-3 py-1 text-sm ${active ? "bg-(--accent) text-white" : "border border-(--gridline) bg-(--surface-2) hover:bg-(--page-plane)"}`;

  return (
    <section className="rounded-lg border border-(--gridline) bg-(--surface-1) p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">完整紀錄（永久保存）</h2>
        {!open && (
          <button type="button" className={btn(false)} onClick={() => setOpen(true)}>
            載入完整紀錄
          </button>
        )}
      </div>
      <p className="mt-1 text-[12px] text-(--text-muted)">
        每筆交易（含未成交）都附當時的評等、五面向、價位框架、市況與成交依據；每個時點另記一筆決策：考慮了哪些候選、為什麼選或不選、持股為什麼動或不動。
      </p>
      {open && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={btn(tab === "trades")} onClick={() => setTab("trades")}>
              交易
            </button>
            <button type="button" className={btn(tab === "decisions")} onClick={() => setTab("decisions")}>
              每個時點的決策
            </button>
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="ml-auto rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1 text-sm"
              aria-label="月份"
            >
              {months.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-3">
            {error ? (
              <p className="text-sm text-(--text-muted)">讀取失敗，請稍後再試。</p>
            ) : !items ? (
              <div className="h-24 animate-pulse rounded-md bg-(--page-plane)" aria-hidden />
            ) : items.length === 0 ? (
              <p className="text-sm text-(--text-muted)">這個月沒有紀錄。</p>
            ) : tab === "trades" ? (
              <TradeList items={items as SimArchivedTrade[]} />
            ) : (
              <DecisionList items={items as SimDecisionRecord[]} />
            )}
          </div>
        </>
      )}
    </section>
  );
}

function TradeList({ items }: { items: SimArchivedTrade[] }) {
  return (
    <ul className="divide-y divide-(--gridline)">
      {[...items].reverse().map((t, i) => (
        <li key={`${t.at}-${t.symbol}-${i}`} className="py-2 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">
              {t.status === "rejected" ? (t.side === "buy" ? "未買到" : "未賣出") : t.side === "buy" ? "買進" : "賣出"} {t.name} {t.symbol}
            </span>
            <span className="tabular-nums">
              {t.shares.toLocaleString("en-US")} 股{t.status === "rejected" ? "" : ` @ ${t.price}`}
            </span>
            {t.side === "sell" && t.status !== "rejected" && <span className="tabular-nums">已實現 {pct(t.realizedPct)}（獎勵 {pct(t.reward)}）</span>}
            <span className="ml-auto text-[12px] text-(--text-muted)">{fmtTime(t.at)}</span>
          </div>
          <p className="text-[13px] text-(--text-secondary)">
            {t.status === "rejected" ? t.rejectReason : t.basis ? `成交依據：${t.basis}` : ""}
          </p>
          {t.rating && (
            <p className="text-[12px] text-(--text-muted)">
              評等「{t.rating.label}」／持有中「{t.rating.appliedHoldingLabel ?? t.rating.holdingLabel}」；支持 {t.rating.supportCount}、不支持 {t.rating.againstCount}（
              {Object.entries(t.rating.facets)
                .map(([k, v]) => `${k}${v}`)
                .join("、")}
              ）{t.rating.regime ? `；市況 ${t.rating.regime}` : ""}
              {t.rating.chaseHits.length > 0 ? `；追高防護 ${t.rating.chaseHits.join("、")}` : ""}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function DecisionList({ items }: { items: SimDecisionRecord[] }) {
  return (
    <ul className="space-y-3">
      {[...items].reverse().map((d, i) => (
        <li key={`${d.at}-${i}`} className="rounded-md bg-(--page-plane) p-3 text-sm">
          <div className="font-medium">
            {fmtTime(d.at)}｜{d.note}
          </div>
          {d.holdings.length > 0 && (
            <div className="mt-1">
              <div className="text-[12px] text-(--text-muted)">持股</div>
              <ul className="text-[13px] text-(--text-secondary)">
                {d.holdings.map((h) => (
                  <li key={`h-${h.symbol}`}>
                    {h.name} {h.symbol}：{h.action === "—" ? "不動作" : h.action}｜{h.why}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d.candidates.length > 0 && (
            <div className="mt-1">
              <div className="text-[12px] text-(--text-muted)">候選（今日建議名單）</div>
              <ul className="text-[13px] text-(--text-secondary)">
                {d.candidates.map((c) => (
                  <li key={`c-${c.symbol}`}>
                    {c.name} {c.symbol}：{c.action === "—" ? "沒選" : c.action}｜{c.why}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
