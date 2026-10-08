"use client";

import { useState } from "react";
import { getWatchlist } from "@/lib/watchlist";
import { api, type Sim, type Strategy } from "./api";
import { btnGhost, btnPrimary, cardCls, inputCls } from "@/components/auth/ui";

/** 文字框裡的代號 → 清單（台股數字代號、美股英文代號；逗號、空白、換行都可以分隔） */
function parseSymbols(text: string): Array<{ symbol: string; market: "TW" | "US"; name: string }> {
  return text
    .split(/[\s,，、]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .map((s) => ({ symbol: s, market: /^[0-9]/.test(s) ? ("TW" as const) : ("US" as const), name: s }));
}

/** 建立或編輯模擬倉（初始資金只有建立時能設定） */
export default function SimForm({
  sim,
  strategies,
  onSaved,
  onCancel,
}: {
  sim?: Sim;
  strategies: Strategy[];
  onSaved: (s: Sim) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(sim?.name ?? "");
  const [strategyId, setStrategyId] = useState(sim?.strategyId ?? strategies[0]?.id ?? "");
  const [universe, setUniverse] = useState<"list" | "market" | "strategy">(sim?.universe ?? "list");
  const chosen = strategies.find((s) => s.id === strategyId);
  const [symbolsText, setSymbolsText] = useState(sim?.symbols.map((s) => s.symbol).join(", ") ?? "");
  const [topN, setTopN] = useState(sim?.marketTopN ?? 30);
  const [initialCash, setInitialCash] = useState(1_000_000);
  const [autoTrade, setAutoTrade] = useState(sim?.autoTrade ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function importWatchlist() {
    const codes = getWatchlist().map((w) => w.symbol);
    const merged = [...new Set([...parseSymbols(symbolsText).map((s) => s.symbol), ...codes])];
    setSymbolsText(merged.join(", "));
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ item: Sim }>("/api/strategy/sims", {
        body: { id: sim?.id, name, strategyId, universe, symbols: parseSymbols(symbolsText), marketTopN: topN, initialCash, autoTrade },
      });
      onSaved(r.item);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`${cardCls} space-y-3`}>
      <h2 className="font-semibold">{sim ? "編輯模擬倉" : "建立模擬倉"}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 text-sm">
          <span>名稱</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：RSI 超賣反彈" className={inputCls} />
        </label>
        <label className="block space-y-1 text-sm">
          <span>使用策略</span>
          <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)} className={inputCls}>
            <option value="">（不使用策略，只手動下單）</option>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-2 text-sm">
        <span>策略要從哪些股票裡挑</span>
        <div className="flex flex-wrap gap-4">
          <label className={`flex items-center gap-1 ${chosen?.config.screen ? "" : "opacity-50"}`} title={chosen?.config.screen ? "" : "所選策略沒有設定股票篩選判斷"}>
            <input type="radio" disabled={!chosen?.config.screen} checked={universe === "strategy"} onChange={() => setUniverse("strategy")} />
            依策略的股票篩選
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={universe === "list"} onChange={() => setUniverse("list")} />
            自選清單
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={universe === "market"} onChange={() => setUniverse("market")} />
            台股全市場成交量前 N 名
          </label>
        </div>
        {universe === "strategy" ? (
          <p className="text-xs text-(--text-muted)">每次執行時依策略「{chosen?.name}」的股票篩選重新產生名單，再用策略判斷買賣。</p>
        ) : universe === "list" ? (
          <div className="space-y-1">
            <textarea
              value={symbolsText}
              onChange={(e) => setSymbolsText(e.target.value)}
              rows={3}
              placeholder="輸入代號，用逗號或空白分隔，例如：2330, 2317, 2454, AAPL"
              className={inputCls}
            />
            <button type="button" className={`${btnGhost} text-xs`} onClick={importWatchlist}>
              ＋ 帶入我的關注清單
            </button>
          </div>
        ) : (
          <label className="flex items-center gap-2">
            前
            <input type="number" min={10} max={100} value={topN} onChange={(e) => setTopN(Number(e.target.value))} className={`${inputCls} !w-24`} />
            名（10～100，建議 30；第一次執行要抓一年日K會比較久，之後每天只抓當月）
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-4 text-sm">
        {!sim && (
          <label className="block space-y-1">
            <span>初始資金（元）</span>
            <input type="number" min={10000} step={10000} value={initialCash} onChange={(e) => setInitialCash(Number(e.target.value))} className={`${inputCls} !w-40`} />
          </label>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={autoTrade} onChange={(e) => setAutoTrade(e.target.checked)} />
          每個交易日收盤後依策略自動交易
        </label>
      </div>

      {error && <p className="text-sm text-(--price-up)">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className={btnPrimary} disabled={busy || !name} onClick={save}>
          {busy ? "儲存中…" : sim ? "儲存" : "建立"}
        </button>
        <button type="button" className={btnGhost} onClick={onCancel}>
          取消
        </button>
      </div>
    </section>
  );
}
