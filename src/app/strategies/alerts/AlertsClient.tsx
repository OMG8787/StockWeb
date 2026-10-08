"use client";

import { useEffect, useState } from "react";
import LabTabs from "@/components/strategy/LabTabs";
import { ALERT_CONFIG_EVENT } from "@/components/strategy/AlertWatcher";
import { api, useList, type Strategy } from "@/components/strategy/api";
import { btnGhost, btnPrimary, cardCls, inputCls } from "@/components/auth/ui";
import { getWatchlist } from "@/lib/watchlist";

interface Config {
  symbols: string[];
  strategyIds: string[];
  intervalSec: number;
  enabled: boolean;
}
type Signal = "buy" | "sell" | null;
interface Check {
  at: string;
  marketOpen: boolean;
  items: Array<{ symbol: string; name: string; price: number | null; allBuy: boolean; error?: string; lines: Array<{ id: string; name: string; current: Signal; summary: string }> }>;
}

const AI = { id: "ai", name: "🤖 AI 建議策略（本站綜合評等）" };
const INTERVALS = [10, 15, 20, 30];

function chip(s: Signal) {
  const cls = s === "buy" ? "border-(--price-up) text-(--price-up)" : s === "sell" ? "border-(--price-down) text-(--price-down)" : "border-(--gridline) text-(--text-muted)";
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${cls}`}>{s === "buy" ? "買進" : s === "sell" ? "賣出" : "不動作"}</span>;
}

export default function AlertsClient() {
  const strategies = useList<Strategy>("/api/strategy/strategies");
  const [cfg, setCfg] = useState<Config | null>(null);
  const [symbolsText, setSymbolsText] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const [perm, setPerm] = useState<string>("default");

  useEffect(() => {
    api<{ config: Config }>("/api/strategy/alerts")
      .then((d) => {
        setCfg(d.config);
        setSymbolsText(d.config.symbols.join(", "));
      })
      .catch((e: Error) => setMsg({ ok: false, text: e.message }));
    const onChecked = (e: Event) => setCheck((e as CustomEvent<Check>).detail);
    window.addEventListener("stockradar:alert-checked", onChecked);
    const t = setTimeout(() => setPerm(typeof Notification === "undefined" ? "unsupported" : Notification.permission), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("stockradar:alert-checked", onChecked);
    };
  }, []);

  const options = [AI, ...(strategies.items ?? []).map((s) => ({ id: s.id, name: s.name }))];

  async function save(next: Config) {
    setBusy(true);
    setMsg(null);
    try {
      const symbols = symbolsText.split(/[\s,，、]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
      const r = await api<{ config: Config }>("/api/strategy/alerts", { body: { ...next, symbols } });
      setCfg(r.config);
      setSymbolsText(r.config.symbols.join(", "));
      window.dispatchEvent(new Event(ALERT_CONFIG_EVENT));
      setMsg({ ok: true, text: r.config.enabled ? "已儲存，提醒已開啟（任何頁面都會在背景追蹤）" : "已儲存（提醒目前關閉）" });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function checkNow() {
    setBusy(true);
    try {
      setCheck(await api<Check>("/api/strategy/alerts/check", { body: {} }));
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function askPermission() {
    if (typeof Notification === "undefined") return;
    const p = await Notification.requestPermission();
    setPerm(p);
    if (p === "granted") new Notification("股情雷達", { body: "已開啟系統通知，策略出現買賣訊號時會通知你。" });
  }

  return (
    <div className="space-y-5 pb-24">
      <LabTabs active="/strategies/alerts" intro="設定要追蹤的股票與策略：盤中每 10～30 秒檢查一次（用即時價），策略出現買進／賣出訊號、或全部策略都買進時，網站右上角與系統通知都會提醒你。要有開著網站的分頁才會檢查。" />
      {msg && <p className={`text-sm ${msg.ok ? "text-(--price-down)" : "text-(--price-up)"}`}>{msg.text}</p>}

      {!cfg ? (
        <p className="text-sm text-(--text-muted)">載入中…</p>
      ) : (
        <section className={`${cardCls} space-y-4`}>
          <div className="space-y-1">
            <div className="text-sm font-medium">追蹤名單（最多 20 檔）</div>
            <div className="flex flex-wrap gap-2">
              <input value={symbolsText} onChange={(e) => setSymbolsText(e.target.value)} placeholder="代號，例如 2330, 2317" className={`${inputCls} !w-auto flex-1`} />
              <button type="button" className={`${btnGhost} text-xs`} onClick={() => setSymbolsText(getWatchlist().slice(0, 20).map((w) => w.symbol).join(", "))}>
                帶入關注清單
              </button>
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-sm font-medium">要追蹤的策略（最多 8 個）</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {options.map((o) => (
                <label key={o.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={cfg.strategyIds.includes(o.id)}
                    onChange={(e) => setCfg({ ...cfg, strategyIds: e.target.checked ? [...cfg.strategyIds, o.id] : cfg.strategyIds.filter((x) => x !== o.id) })}
                  />
                  {o.name}
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              檢查間隔
              <select value={cfg.intervalSec} onChange={(e) => setCfg({ ...cfg, intervalSec: Number(e.target.value) })} className={`${inputCls} !w-auto`}>
                {INTERVALS.map((s) => (
                  <option key={s} value={s}>
                    每 {s} 秒
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
              開啟即時提醒
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} disabled={busy} onClick={() => save(cfg)}>
              儲存設定
            </button>
            <button type="button" className={btnGhost} disabled={busy} onClick={checkNow}>
              立即檢查一次
            </button>
            {perm === "granted" ? (
              <span className="self-center text-xs text-(--price-down)">✅ 系統通知已開啟</span>
            ) : perm === "unsupported" ? (
              <span className="self-center text-xs text-(--text-muted)">這個瀏覽器不支援系統通知，只會在網站右上角提醒</span>
            ) : (
              <button type="button" className={btnGhost} onClick={askPermission}>
                🔔 允許系統通知
              </button>
            )}
          </div>
        </section>
      )}

      {check && (
        <section className="space-y-2">
          <h2 className="font-semibold">
            目前訊號 <span className="text-xs font-normal text-(--text-muted)">（{new Date(check.at).toLocaleTimeString("zh-TW")} 檢查，{check.marketOpen ? "盤中" : "非交易時段，每 5 分鐘檢查"}）</span>
          </h2>
          {check.items.length === 0 && <p className="text-sm text-(--text-muted)">名單或策略是空的。</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            {check.items.map((it) => (
              <div key={it.symbol} className={`${cardCls} !p-3 text-sm ${it.allBuy ? "!border-(--price-up)" : ""}`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {it.name} <span className="text-xs text-(--text-muted)">{it.symbol}</span>
                  </span>
                  <span>{it.price ?? "—"}</span>
                </div>
                {it.error && <p className="text-xs text-(--price-up)">{it.error}</p>}
                {it.allBuy && <p className="mt-1 text-xs font-semibold text-(--price-up)">✅ 全部策略都是買進</p>}
                <ul className="mt-1 space-y-0.5">
                  {it.lines.map((l) => (
                    <li key={l.id} className="flex items-center gap-2 text-xs">
                      {chip(l.current)} {l.name}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
