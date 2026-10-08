"use client";

import { useEffect, useState } from "react";
import type { OrderBook } from "@/lib/data/orderBook";
import { taipeiClock } from "@/lib/strategy/alertFormat";

/** 盤中每 5 秒刷新（當沖要看的就是這幾秒的變化）；非交易時段 60 秒；分頁在背景時不抓 */
const OPEN_MS = 5_000;
const CLOSED_MS = 60_000;

function marketOpen(): boolean {
  const c = taipeiClock();
  return c.weekday >= 1 && c.weekday <= 5 && c.minutes >= 9 * 60 && c.minutes <= 13 * 60 + 33;
}

function Book({ b }: { b: OrderBook }) {
  const max = Math.max(1, ...b.bids.map((l) => l.volume), ...b.asks.map((l) => l.volume));
  const ref = b.prevClose ?? b.price ?? 0;
  const color = (p: number) => (p > ref ? "text-(--price-up)" : p < ref ? "text-(--price-down)" : "");
  const total = b.bidTotal + b.askTotal;
  const bidPct = total ? Math.round((b.bidTotal / total) * 100) : 50;
  const rows = Array.from({ length: 5 }, (_, i) => ({ bid: b.bids[i], ask: b.asks[i] }));
  return (
    <div className="space-y-1 rounded-md border border-(--gridline) p-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium">
          {b.symbol} {b.name !== b.symbol && b.name}
        </span>
        <span className={b.price != null ? color(b.price) : ""}>
          {b.price ?? "—"}
          {b.time && <span className="ml-1 text-(--text-muted)">{new Date(b.time).toLocaleTimeString("zh-TW", { hour12: false })}</span>}
        </span>
      </div>
      <table className="w-full tabular-nums">
        <thead>
          <tr className="text-(--text-muted)">
            <th className="text-left font-normal">委買量</th>
            <th className="text-right font-normal">買價</th>
            <th className="text-left font-normal pl-2">賣價</th>
            <th className="text-right font-normal">委賣量</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="relative">
                {r.bid && <span className="absolute inset-y-0.5 right-0 rounded-sm bg-(--price-up) opacity-15" style={{ width: `${(r.bid.volume / max) * 100}%` }} />}
                <span className="relative">{r.bid?.volume ?? ""}</span>
              </td>
              <td className={`text-right ${r.bid ? color(r.bid.price) : ""}`}>{r.bid?.price ?? "—"}</td>
              <td className={`pl-2 ${r.ask ? color(r.ask.price) : ""}`}>{r.ask?.price ?? "—"}</td>
              <td className="relative text-right">
                {r.ask && <span className="absolute inset-y-0.5 left-0 rounded-sm bg-(--price-down) opacity-15" style={{ width: `${(r.ask.volume / max) * 100}%` }} />}
                <span className="relative">{r.ask?.volume ?? ""}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* 委買／委賣力道條 */}
      <div className="flex h-1.5 overflow-hidden rounded-full bg-(--surface-2)">
        <div className="bg-(--price-up)" style={{ width: `${bidPct}%` }} />
        <div className="bg-(--price-down)" style={{ width: `${100 - bidPct}%` }} />
      </div>
      <div className="flex justify-between text-(--text-muted)">
        <span>委買 {b.bidTotal} 張（{bidPct}%）</span>
        <span>委賣 {b.askTotal} 張</span>
      </div>
    </div>
  );
}

export default function OrderBookPanel({ symbols, title = "📊 即時五檔" }: { symbols: string[]; title?: string }) {
  const tw = symbols.filter((s) => /^[0-9][0-9A-Z]{3,5}$/.test(s)).slice(0, 20);
  const key = tw.join(",");
  const [books, setBooks] = useState<OrderBook[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<boolean | null>(null);

  useEffect(() => {
    if (!key) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function load() {
      const isOpen = marketOpen();
      setOpen(isOpen);
      if (document.visibilityState === "visible") {
        try {
          const r = await fetch(`/api/strategy/orderbook?symbols=${encodeURIComponent(key)}`, { cache: "no-store" });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error ?? `讀取失敗（${r.status}）`);
          if (!stopped) {
            setBooks(d.items);
            setErr("");
          }
        } catch (e) {
          if (!stopped) setErr((e as Error).message);
        }
      }
      if (!stopped) timer = setTimeout(load, isOpen ? OPEN_MS : CLOSED_MS);
    }
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible" && timer) {
        clearTimeout(timer);
        void load();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key]);

  if (!key) return <p className="text-xs text-(--text-muted)">五檔只有台股：請先輸入台股代號。</p>;
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">
        {title}
        <span className="ml-2 text-xs font-normal text-(--text-muted)">{open === null ? "" : open ? "盤中每 5 秒自動刷新" : "非交易時段（顯示最後一筆，每分鐘刷新）"}</span>
      </div>
      {err && <p className="text-xs text-(--price-up)">{err}</p>}
      {books === null && !err && <p className="text-xs text-(--text-muted)">載入中…</p>}
      {books && books.length < tw.length && (
        <p className="text-xs text-(--text-muted)">
          查不到五檔：{tw.filter((s) => !books.some((b) => b.symbol === s)).join("、")}（代號不對、興櫃，或不是上市櫃股票）
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {books?.map((b) => (
          <Book key={b.symbol} b={b} />
        ))}
      </div>
    </div>
  );
}
