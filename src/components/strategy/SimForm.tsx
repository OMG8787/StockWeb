"use client";

import { useState } from "react";
import SourcePicker from "./SourcePicker";
import { api, type Sim, type SourceMode, type StockSource, type Strategy } from "./api";
import { btnGhost, btnPrimary, cardCls, inputCls } from "@/components/auth/ui";

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
  const chosen = strategies.find((s) => s.id === strategyId);
  const [sources, setSources] = useState<StockSource[]>(sim?.sources ?? []);
  const [sourceMode, setSourceMode] = useState<SourceMode>(sim?.sourceMode ?? "union");
  const [initialCash, setInitialCash] = useState(1_000_000);
  const [autoTrade, setAutoTrade] = useState(sim?.autoTrade ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ item: Sim }>("/api/strategy/sims", {
        body: { id: sim?.id, name, strategyId, sources, sourceMode, initialCash, autoTrade },
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

      <SourcePicker
        title="📋 策略要從哪些股票裡挑（可複選）"
        sources={sources}
        mode={sourceMode}
        onChange={(list, m) => {
          setSources(list);
          setSourceMode(m);
        }}
        allowStrategy
        strategy={chosen}
        emptyHint="還沒選股票來源：從上面的按鈕挑一個或多個（例如「自選清單」＋「台股成交量前 N 名」），每個交易日收盤後策略會從這些股票裡判斷買賣。只手動下單的話可以不選。"
      />

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
