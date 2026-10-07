"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import LabTabs from "@/components/strategy/LabTabs";
import SimForm from "@/components/strategy/SimForm";
import { api, money, pct, upDownCls, useList, type Sim, type Strategy } from "@/components/strategy/api";
import { btnGhost, btnPrimary, cardCls, inputCls } from "@/components/auth/ui";

interface Trade {
  id: string;
  day: string;
  at: string;
  side: "buy" | "sell";
  market: "TW" | "US";
  symbol: string;
  name: string;
  shares: number;
  price: number;
  fee: number;
  pnl: number | null;
  source: "auto" | "manual";
  reason: string;
}
interface NavPoint {
  day: string;
  equity: number;
  cash: number;
  indexClose: number | null;
}
interface Detail {
  sim: Sim;
  trades: Trade[];
  nav: NavPoint[];
}

const th = "px-2 py-2 text-left text-xs font-medium text-(--text-muted) whitespace-nowrap";
const td = "px-2 py-2 text-sm whitespace-nowrap";

/** 淨值走勢（模擬倉 vs 加權指數，都換算成起點 0% 的報酬率） */
function NavChart({ nav, initialCash }: { nav: NavPoint[]; initialCash: number }) {
  if (nav.length < 2) return <p className="text-sm text-(--text-muted)">累積兩個交易日以上的淨值後會顯示走勢圖。</p>;
  const W = 600;
  const H = 160;
  const simR = nav.map((p) => (p.equity / initialCash - 1) * 100);
  const base = nav.find((p) => p.indexClose)?.indexClose ?? null;
  const idxR = nav.map((p) => (base && p.indexClose ? (p.indexClose / base - 1) * 100 : null));
  const all = [...simR, ...idxR.filter((x): x is number => x != null), 0];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const y = (v: number) => H - 10 - ((v - lo) / (hi - lo || 1)) * (H - 20);
  const x = (i: number) => (i / (nav.length - 1)) * W;
  const line = (vals: Array<number | null>) =>
    vals.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(" ");
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" preserveAspectRatio="none" role="img" aria-label="淨值走勢">
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--gridline)" strokeDasharray="4 4" />
        <polyline points={line(idxR)} fill="none" stroke="var(--text-muted)" strokeWidth={1.5} />
        <polyline points={line(simR)} fill="none" stroke="var(--accent)" strokeWidth={2.5} />
      </svg>
      <div className="flex justify-between text-xs text-(--text-muted)">
        <span>{nav[0].day}</span>
        <span>
          <span className="text-(--accent)">━ 模擬倉 {pct(simR.at(-1)!)}</span>
          {idxR.at(-1) != null && <span className="ml-3">━ 加權指數 {pct(idxR.at(-1)!)}</span>}
        </span>
        <span>{nav.at(-1)!.day}</span>
      </div>
    </div>
  );
}

export default function SimDetailClient({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [quotes, setQuotes] = useState<Record<string, { price: number } | null>>({});
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [symbol, setSymbol] = useState("");
  const [shares, setShares] = useState(1000);
  const strategies = useList<Strategy>("/api/strategy/strategies");

  const load = useCallback(async () => {
    try {
      setData(await api<Detail>(`/api/strategy/sims/${encodeURIComponent(id)}`));
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  // 持股的最新報價（算市值與未實現損益）
  const positions = data?.sim.positions;
  useEffect(() => {
    if (!positions?.length) return;
    const items = positions.map((p) => `${p.market}:${p.symbol}`).join(",");
    fetch(`/api/quotes?items=${encodeURIComponent(items)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setQuotes(d.items ?? {}))
      .catch(() => {});
  }, [positions]);

  const live = useMemo(() => {
    if (!data) return null;
    const rows = data.sim.positions.map((p) => {
      const price = quotes[`${p.market}:${p.symbol}`]?.price ?? null;
      const value = (price ?? p.avgCost) * p.shares;
      return { ...p, price, value, pnlPct: price ? (price / p.avgCost - 1) * 100 : null };
    });
    const equity = data.sim.cash + rows.reduce((a, r) => a + r.value, 0);
    return { rows, equity, missingQuotes: rows.filter((r) => r.price == null).length };
  }, [data, quotes]);

  async function act(fn: () => Promise<string>) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      setNotice(await fn());
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <p className="text-sm text-(--price-up)">{error}</p>;
  if (!data || !live) return <p className="text-sm text-(--text-muted)">載入中…</p>;
  const { sim, trades, nav } = data;
  const strategy = strategies.items?.find((s) => s.id === sim.strategyId);
  const totalReturn = (live.equity / sim.initialCash - 1) * 100;
  const sells = trades.filter((t) => t.side === "sell" && t.pnl != null);
  const wins = sells.filter((t) => (t.pnl ?? 0) > 0).length;

  return (
    <div className="space-y-5 pb-24">
      <LabTabs active="/sim" intro="" />
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/sim" className="text-sm text-(--accent)">
          ← 全部模擬倉
        </Link>
        <h1 className="text-xl font-semibold">{sim.name}</h1>
        <span className="text-sm text-(--text-muted)">
          {strategy ? `策略：${strategy.name}` : sim.strategyId ? "（策略已刪除）" : "只手動下單"}・
          {sim.universe === "market" ? `全市場前 ${sim.marketTopN} 名` : `自選 ${sim.symbols.length} 檔`}・{sim.autoTrade ? "自動交易中" : "未開自動交易"}
        </span>
      </div>

      {error && <p className="text-sm text-(--price-up)">⚠️ {error}</p>}
      {notice && <p className="rounded-md border border-(--accent) bg-(--accent-soft) px-3 py-2 text-sm">{notice}</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          [live.missingQuotes ? `總值（${live.missingQuotes} 檔現價暫缺，以成本計）` : "總值（即時）", money(live.equity), ""],
          ["報酬率", pct(totalReturn), upDownCls(totalReturn)],
          ["現金", money(sim.cash), ""],
          ["已平倉勝率", sells.length ? `${Math.round((wins / sells.length) * 100)}%（${wins}/${sells.length}）` : "—", ""],
        ].map(([label, value, cls]) => (
          <div key={label} className={`${cardCls} !p-3`}>
            <div className="text-xs text-(--text-muted)">{label}</div>
            <div className={`text-lg font-bold ${cls}`}>{value}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-(--text-muted)">
        初始資金 {money(sim.initialCash)}・建立於 {sim.createdAt.slice(0, 10)}
        {sim.lastRunNote && `・最近執行：${sim.lastRunDay && !sim.lastRunNote.startsWith(sim.lastRunDay) ? `${sim.lastRunDay} ` : ""}${sim.lastRunNote}`}
      </p>

      <div className="flex flex-wrap gap-2">
        {sim.strategyId && (
          <button
            type="button"
            className={btnPrimary}
            disabled={busy}
            onClick={() =>
              act(async () => {
                const r = await api<{ note: string; trades: number }>(`/api/strategy/sims/${id}/run`, { body: {} });
                return `執行完成：${r.note}`;
              })
            }
          >
            {busy ? "執行中，可能要 1～3 分鐘…" : "▶ 立即依策略執行"}
          </button>
        )}
        <button type="button" className={btnGhost} onClick={() => setEditing((e) => !e)}>
          ⚙️ 設定
        </button>
        <button
          type="button"
          className={btnGhost}
          disabled={busy}
          onClick={() =>
            confirm(`確定刪除模擬倉「${sim.name}」？交易紀錄會一起刪除。`) &&
            act(async () => {
              await api(`/api/strategy/sims?id=${encodeURIComponent(id)}`, { method: "DELETE" });
              router.push("/sim");
              return "";
            })
          }
        >
          🗑 刪除
        </button>
      </div>

      {editing && (
        <SimForm
          sim={sim}
          strategies={strategies.items ?? []}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            setNotice("設定已儲存");
            await load();
          }}
        />
      )}

      <section className={`${cardCls} space-y-2`}>
        <h2 className="font-semibold">淨值走勢</h2>
        <NavChart nav={nav} initialCash={sim.initialCash} />
      </section>

      <section className={`${cardCls} space-y-3`}>
        <h2 className="font-semibold">手動下單</h2>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <select value={side} onChange={(e) => setSide(e.target.value as "buy" | "sell")} className={`${inputCls} !w-24`}>
            <option value="buy">買進</option>
            <option value="sell">賣出</option>
          </select>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="代號，例如 2330" className={`${inputCls} !w-36`} />
          <input type="number" min={1} value={shares} onChange={(e) => setShares(Number(e.target.value))} className={`${inputCls} !w-28`} />
          <span className="pb-2 text-xs text-(--text-muted)">股（1 張＝1000 股）</span>
          <button
            type="button"
            className={btnPrimary}
            disabled={busy || !symbol.trim() || !(shares >= 1)}
            onClick={() =>
              act(async () => {
                const r = await api<{ price: number; fee: number; pnl?: number; priceNote: string }>(`/api/strategy/sims/${id}/trade`, { body: { side, symbol, shares } });
                return `已${side === "buy" ? "買進" : "賣出"} ${symbol.toUpperCase()} ${shares} 股，成交價 ${r.price}（${r.priceNote}），手續費／稅 ${money(r.fee)}${r.pnl != null ? `，損益 ${money(r.pnl)}` : ""}`;
              })
            }
          >
            送出
          </button>
        </div>
        <p className="text-xs text-(--text-muted)">以送出當下的最新報價成交（盤中為即時價，收盤後為收盤價）。</p>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">目前持股（{live.rows.length}）</h2>
        {live.rows.length === 0 ? (
          <p className="text-sm text-(--text-muted)">目前沒有持股。</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-(--gridline) bg-(--surface-1)">
            <table className="w-full">
              <thead className="border-b border-(--gridline)">
                <tr>
                  {["股票", "股數", "成本", "現價", "市值", "損益%", "買進日", ""].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {live.rows.map((r) => (
                  <tr key={`${r.market}:${r.symbol}`} className="border-b border-(--gridline) last:border-0">
                    <td className={td}>
                      <Link href={`/stock/${r.symbol}`} prefetch={false} className="hover:underline">
                        {r.name} <span className="text-xs text-(--text-muted)">{r.symbol}</span>
                      </Link>
                    </td>
                    <td className={td}>{r.shares.toLocaleString()}</td>
                    <td className={td}>{r.avgCost.toFixed(2)}</td>
                    <td className={td}>{r.price ?? "—"}</td>
                    <td className={td}>{money(r.value)}</td>
                    <td className={`${td} ${upDownCls(r.pnlPct ?? 0)}`}>{r.pnlPct == null ? "—" : pct(r.pnlPct)}</td>
                    <td className={td}>{r.buyDay}</td>
                    <td className={td}>
                      <button type="button" className={`${btnGhost} text-xs`} onClick={() => { setSide("sell"); setSymbol(r.symbol); setShares(r.shares); }}>
                        賣出
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">交易紀錄（{trades.length}）</h2>
        {trades.length === 0 ? (
          <p className="text-sm text-(--text-muted)">還沒有交易。</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-(--gridline) bg-(--surface-1)">
            <table className="w-full">
              <thead className="border-b border-(--gridline)">
                <tr>
                  {["日期", "買賣", "股票", "股數", "價格", "費用", "損益", "來源", "原因"].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id} className="border-b border-(--gridline) last:border-0">
                    <td className={td}>{t.day}</td>
                    <td className={`${td} ${t.side === "buy" ? "text-(--price-up)" : "text-(--price-down)"}`}>{t.side === "buy" ? "買進" : "賣出"}</td>
                    <td className={td}>
                      {t.name} <span className="text-xs text-(--text-muted)">{t.symbol}</span>
                    </td>
                    <td className={td}>{t.shares.toLocaleString()}</td>
                    <td className={td}>{t.price}</td>
                    <td className={td}>{money(t.fee)}</td>
                    <td className={`${td} ${upDownCls(t.pnl ?? 0)}`}>{t.pnl == null ? "—" : money(t.pnl)}</td>
                    <td className={td}>{t.source === "auto" ? "策略" : "手動"}</td>
                    <td className="max-w-xs px-2 py-2 text-xs text-(--text-secondary)">{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
